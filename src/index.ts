import { URL } from "url";
import { request as httpRequest, IncomingMessage } from "http";
import { request as httpsRequest, RequestOptions } from "https";
import { BaseError } from "make-error-cause";
import {
  connect as netConnect,
  Socket,
  AddressInfo,
  NetConnectOpts,
} from "net";
import {
  connect as tlsConnect,
  SecureContext,
  TLSSocket,
  ConnectionOptions as TlsConnectOpts,
} from "tls";
import {
  connect as http2Connect,
  IncomingHttpHeaders,
  constants as h2constants,
  ClientHttp2Session,
} from "http2";
import { pipeline, PassThrough, Writable, Readable } from "stream";
import { lookup as dnsLookup, LookupOptions } from "dns";
import {
  Request,
  Response,
  CreateBody,
  ResponseOptions,
  HeadersInit,
} from "servie/dist/node";
import { useRawBody } from "servie/dist/common";

/**
 * Add HTTP signals to servie events.
 */
declare module "servie/dist/signal" {
  export interface SignalEvents {
    error: [Error];
  }
}

/**
 * Address information from the HTTP request.
 */
export interface Connection {
  localPort: number;
  localAddress: string;
  remotePort: number;
  remoteAddress: string;
  encrypted: boolean;
}

/**
 * Extend response with URL.
 */
export interface HttpResponseOptions extends ResponseOptions {
  url: string;
  connection: Connection;
  httpVersion: string;
}

/**
 * HTTP responses implement a node.js body.
 */
export class HttpResponse extends Response implements HttpResponseOptions {
  url: string;
  httpVersion: string;
  connection: Connection;

  constructor(body: CreateBody, options: HttpResponseOptions) {
    super(body, options);
    this.url = options.url;
    this.connection = options.connection;
    this.httpVersion = options.httpVersion;
  }
}

export class Http2Response extends HttpResponse {
  // TODO: Add HTTP2 features.
}

/**
 * Abstract connection manager.
 */
export interface ConnectionManager<T> {
  /**
   * Request a connection and initialize in `onReady` once available.
   */
  ready(
    key: string,
    onReady: (connection: T | undefined) => T | Promise<T>
  ): Promise<T>;
  /**
   * Create a connection within the `create` callback for tracking.
   */
  creating(key: string, create: () => Promise<T>): Promise<T>;
  /**
   * Claims an existing connection as "in-use".
   */
  used(key: string, connection: T): void;
  /**
   * Removes a connection from "in-use" using the connection key and connection.
   * Return `true` when the connection has been deleted from the manager and the
   * connection must be destroyed.
   */
  freed(key: string, connection: T): boolean;
  /**
   * Gets any connection (or `undefined` when none exist) using the connection key.
   */
  get(key: string): T | undefined;
  /**
   * Gets a free connection (or `undefined` if none are free) using the connection key.
   */
  free(key: string): T | undefined;
  /**
   * Deletes a connection from free and in-use using the connection key.
   */
  delete(key: string, connection: T): void;
}

/**
 * Set of connections for HTTP pooling.
 */
export class SocketSet<T> {
  // Tracks number of sockets claimed before they're created.
  creating = 0;
  // Tracks free sockets.
  free = new Set<T>();
  // Tracks all available sockets.
  sockets = new Set<T>();
  // Tracks pending requests for a socket.
  pending: Array<(connection: T | undefined) => void> = [];
  // Get number of sockets available + creating.
  size(): number {
    return this.creating + this.sockets.size;
  }
  // Check if the pool is empty and can be cleaned up.
  isEmpty(): boolean {
    return this.size() === 0 && this.pending.length === 0;
  }
}

/**
 * Get the value of an iterator.
 */
function value<T>(iterator: Iterator<T, undefined>): T | undefined {
  return iterator.next().value;
}

/**
 * Manage socket reuse.
 */
export class SocketConnectionManager<T extends Socket | TLSSocket>
  implements ConnectionManager<T> {
  pools = new Map<string, SocketSet<T>>();

  constructor(
    public maxFreeConnections = 256,
    public maxConnections = Infinity
  ) {}

  /**
   * Creates a connection when available.
   */
  async ready(
    key: string,
    onReady: (connection: T | undefined) => T | Promise<T>
  ): Promise<T> {
    const pool = this.pool(key);

    // Add to "pending" queue when over max connections.
    if (pool.size() >= this.maxConnections) {
      return new Promise<T | undefined>((resolve) =>
        pool.pending.push(resolve)
      ).then(onReady);
    }

    return onReady(this.free(key));
  }

  async creating(key: string, onCreate: () => Promise<T>): Promise<T> {
    const pool = this.pool(key);
    try {
      pool.creating++;
      const socket = await onCreate();
      return socket;
    } finally {
      pool.creating--;
    }
  }

  pool(key: string): SocketSet<T> {
    const pool = this.pools.get(key);
    if (!pool) {
      const pool = new SocketSet<T>();
      this.pools.set(key, pool);
      return pool;
    }
    return pool;
  }

  used(key: string, socket: T): void {
    socket.ref();

    const pool = this.pool(key);
    pool.free.delete(socket);
    pool.sockets.add(socket);
  }

  freed(key: string, socket: T): boolean {
    const pool = this.pools.get(key);
    if (!pool || !pool.sockets.has(socket)) return false;

    // Immediately reuse for a pending connection.
    const onReady = pool.pending.shift();
    if (onReady) {
      onReady(socket);
      return false;
    }

    // Remove reference to freed sockets.
    socket.unref();

    // Save freed connections for reuse.
    if (pool.free.size < this.maxFreeConnections) {
      pool.free.add(socket);
      return false;
    }

    this._delete(pool, key, socket);
    return true;
  }

  private _delete(pool: SocketSet<T>, key: string, socket: T) {
    pool.free.delete(socket);
    pool.sockets.delete(socket);
    if (pool.isEmpty()) this.pools.delete(key);
  }

  get(key: string): T | undefined {
    const pool = this.pools.get(key);
    if (pool) return value(pool.sockets.values());
  }

  free(key: string): T | undefined {
    const pool = this.pools.get(key);
    if (pool) return value(pool.free.values());
  }

  delete(key: string, socket: T): void {
    const pool = this.pools.get(key);
    if (!pool || !pool.sockets.has(socket)) return;

    // Remove the socket from the pool before calling a new `onReady`.
    this._delete(pool, key, socket);

    // Create a new pending socket when an old socket is removed.
    // If a socket was removed we MUST be below `maxConnections`.
    // We also MUST have already used our `free` connections up otherwise we
    // wouldn't have a pending callback.
    const onReady = pool.pending.shift();
    if (onReady) onReady(undefined);
  }
}

export class Http2ConnectionManager
  implements ConnectionManager<ClientHttp2Session> {
  sessions = new Map<string, ClientHttp2Session>();
  refs = new WeakMap<ClientHttp2Session, number>();

  async ready(
    key: string,
    onReady: (
      session: ClientHttp2Session | undefined
    ) => ClientHttp2Session | Promise<ClientHttp2Session>
  ): Promise<ClientHttp2Session> {
    return onReady(this.sessions.get(key));
  }

  async creating(
    key: string,
    create: () => Promise<ClientHttp2Session>
  ): Promise<ClientHttp2Session> {
    return create();
  }

  used(key: string, session: ClientHttp2Session): void {
    const count = this.refs.get(session) || 0;
    if (count === 0) session.ref();

    this.refs.set(session, count + 1);
    this.sessions.set(key, session);
  }

  freed(key: string, session: ClientHttp2Session): boolean {
    const count = this.refs.get(session);
    if (!count) return false;
    if (count === 1) session.unref();
    this.refs.set(session, count - 1);
    return false;
  }

  get(key: string): ClientHttp2Session | undefined {
    return this.sessions.get(key);
  }

  free(key: string): ClientHttp2Session | undefined {
    return this.sessions.get(key);
  }

  delete(key: string, session: ClientHttp2Session): void {
    if (this.sessions.get(key) === session) {
      this.refs.delete(session);
      this.sessions.delete(key);
    }
  }
}

export const defaultNetConnect: CreateNetConnection = netConnect;
export const defaultTlsConnect: CreateTlsConnection = tlsConnect;
export const defaultHttp2Connect: CreateHttp2Connection = (
  authority,
  socket
) => {
  return http2Connect(authority, { createConnection: () => socket });
};

function pipelineRequest(
  req: Request,
  stream: Writable,
  onError: (err: Error) => void
): void {
  let bytesTransferred = 0;
  const onData = (chunk: Buffer) => {
    req.signal.emit("requestBytes", (bytesTransferred += chunk.length));
  };

  const requestStream = new PassThrough();
  requestStream.on("data", onData);
  req.signal.emit("requestStarted");

  pipeline(requestStream, stream, (err) => {
    requestStream.removeListener("data", onData);

    if (err) req.signal.emit("error", err);
    req.signal.emit("requestEnded");
  });

  const body = useRawBody(req);

  if (body instanceof ArrayBuffer) {
    return requestStream.end(new Uint8Array(body));
  }

  if (Buffer.isBuffer(body) || typeof body === "string" || body === null) {
    return requestStream.end(body);
  }

  pipeline(body, requestStream, (err) => {
    if (err) return onError(err);
  });
}

function pipelineResponse(req: Request, stream: Readable, onEnd: () => void) {
  let bytesTransferred = 0;
  const onData = (chunk: Buffer) => {
    req.signal.emit("responseBytes", (bytesTransferred += chunk.length));
  };

  const responseStream = new PassThrough();
  stream.on("data", onData);
  req.signal.emit("responseStarted");

  return pipeline(stream, responseStream, (err) => {
    stream.removeListener("data", onData);

    onEnd();

    if (err) req.signal.emit("error", err);
    req.signal.emit("responseEnded");
  });
}

/**
 * Used as a cause for the connection error.
 */
export class CausedByEarlyCloseError extends Error {
  constructor() {
    super("Connection closed too early");
  }
}

/**
 * Used as a cause for the connection error.
 */
export class CausedByTimeoutError extends Error {
  constructor() {
    super("Connection timeout");
  }
}

/**
 * Expose connection errors.
 */
export class ConnectionError extends BaseError {
  code = "EUNAVAILABLE";

  constructor(public request: Request, message: string, cause: Error) {
    super(message, cause);
  }
}

/**
 * Execute HTTP request.
 */
function execHttp1(
  req: Request,
  url: URL,
  socket: Socket | TLSSocket,
  config: TransportConfig
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const encrypted = url.protocol === "https:";
    const request: typeof httpRequest = encrypted ? httpsRequest : httpRequest;

    const arg: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      defaultPort: encrypted ? 443 : 80, // Specify to avoid `Host` header issues.
      method: req.method,
      path: url.pathname + url.search,
      headers: req.headers.asObject(),
      auth:
        url.username || url.password
          ? `${url.username}:${url.password}`
          : undefined,
      createConnection: () => socket,
    };

    const rawRequest = request(arg);

    rawRequest.on("timeout", () => {
      rawRequest.destroy();

      return reject(
        new ConnectionError(
          req,
          `Connection timed out to ${url.host}`,
          new CausedByTimeoutError()
        )
      );
    });

    // Timeout when no activity, pick minimum as request is using the entire socket.
    rawRequest.setTimeout(
      config.idleSocketTimeout > 0
        ? Math.min(config.idleRequestTimeout, config.idleSocketTimeout)
        : config.idleRequestTimeout
    );

    // Reuse HTTP connections where possible.
    if (config.keepAlive > 0) {
      rawRequest.shouldKeepAlive = true;
      rawRequest.setHeader("Connection", "keep-alive");
    }

    // Trigger unavailable error when node.js errors before response.
    const onRequestError = (err: Error) => {
      return reject(
        new ConnectionError(req, `Unable to connect to ${url.host}`, err)
      );
    };

    // Track the node.js response.
    const onResponse = (rawResponse: IncomingMessage) => {
      // Trailers are populated on "end".
      let resolveTrailers: (headers: HeadersInit) => void;
      const trailer = new Promise<HeadersInit>(
        (resolve) => (resolveTrailers = resolve)
      );

      rawRequest.removeListener("response", onResponse);
      rawRequest.removeListener("error", onRequestError);

      const {
        address: localAddress,
        port: localPort,
      } = (rawRequest.socket?.address() ?? {}) as AddressInfo;

      const {
        address: remoteAddress,
        port: remotePort,
      } = rawResponse.socket.address() as AddressInfo;

      // Force `end` to be triggered so the response can still be piped.
      // Reference: https://github.com/nodejs/node/issues/27981
      const onAborted = () => {
        rawResponse.push(null);
      };

      rawResponse.on("aborted", onAborted);

      const res = new HttpResponse(
        pipelineResponse(req, rawResponse, () => {
          req.signal.off("abort", onAbort);
          rawResponse.removeListener("aborted", onAborted);

          resolveTrailers(rawResponse.trailers);
        }),
        {
          status: rawResponse.statusCode,
          statusText: rawResponse.statusMessage,
          url: req.url,
          headers: rawResponse.headers,
          omitDefaultHeaders: true,
          trailer,
          connection: {
            localAddress,
            localPort,
            remoteAddress,
            remotePort,
            encrypted,
          },
          httpVersion: rawResponse.httpVersion,
        }
      );

      return resolve(res);
    };

    const onAbort = () => {
      rawRequest.destroy();
    };

    // Clean up lingering request listeners on close.
    const onClose = () => {
      req.signal.off("abort", onAbort);
      rawRequest.removeListener("error", onRequestError);
      rawRequest.removeListener("response", onResponse);
      rawRequest.removeListener("close", onClose);
    };

    req.signal.on("abort", onAbort);
    rawRequest.once("error", onRequestError);
    rawRequest.once("response", onResponse);
    rawRequest.once("close", onClose);

    return pipelineRequest(req, rawRequest, reject);
  });
}

/**
 * ALPN validation error.
 */
export class ALPNError extends Error {
  code = "EALPNPROTOCOL";

  constructor(public request: Request, message: string) {
    super(message);
  }
}

/**
 * Execute a HTTP2 connection.
 */
function execHttp2(
  key: string,
  client: ClientHttp2Session,
  req: Request,
  url: URL,
  config: TransportConfig
): Promise<Http2Response> {
  return new Promise<Http2Response>((resolve, reject) => {
    // HTTP2 formatted headers.
    const headers = Object.assign(
      {
        [h2constants.HTTP2_HEADER_METHOD]: req.method,
        [h2constants.HTTP2_HEADER_AUTHORITY]: url.host,
        [h2constants.HTTP2_HEADER_SCHEME]: url.protocol.slice(0, -1),
        [h2constants.HTTP2_HEADER_PATH]: url.pathname + url.search,
      },
      req.headers.asObject()
    );

    const http2Stream = client.request(headers, { endStream: false });
    let cause = new CausedByEarlyCloseError();

    // Handle socket timeouts more gracefully.
    const onSocketTimeout = () => {
      cause = new CausedByTimeoutError();
    };

    // Timeout after no activity.
    http2Stream.setTimeout(config.idleRequestTimeout, () => {
      cause = new CausedByTimeoutError();
      http2Stream.close(h2constants.NGHTTP2_CANCEL);
    });

    // Trigger unavailable error when node.js errors before response.
    const onRequestError = (err: Error) => {
      return reject(
        new ConnectionError(req, `Unable to connect to ${url.host}`, err)
      );
    };

    const onResponse = (headers: IncomingHttpHeaders) => {
      const encrypted = (client.socket as TLSSocket).encrypted === true;
      const {
        localAddress = "",
        localPort = 0,
        remoteAddress = "",
        remotePort = 0,
      } = client.socket;

      let resolveTrailers: (headers: HeadersInit) => void;
      const trailer = new Promise<HeadersInit>(
        (resolve) => (resolveTrailers = resolve)
      );

      const onTrailers = (headers: IncomingHttpHeaders) => {
        resolveTrailers(headers);
      };

      http2Stream.once("trailers", onTrailers);

      const res = new Http2Response(
        pipelineResponse(req, http2Stream, () => {
          req.signal.off("abort", onAbort);
          http2Stream.removeListener("trailers", onTrailers);

          resolveTrailers({}); // Resolve in case "trailers" wasn't emitted.
        }),
        {
          status: Number(headers[h2constants.HTTP2_HEADER_STATUS]),
          statusText: "",
          url: req.url,
          httpVersion: "2.0",
          headers,
          omitDefaultHeaders: true,
          trailer,
          connection: {
            localAddress,
            localPort,
            remoteAddress,
            remotePort,
            encrypted,
          },
        }
      );

      return resolve(res);
    };

    const onAbort = () => {
      http2Stream.destroy();
    };

    // Release the HTTP2 connection claim when the stream ends.
    const onClose = () => {
      // Clean up all lingering event listeners on final close.
      req.signal.off("abort", onAbort);
      http2Stream.removeListener("error", onRequestError);
      http2Stream.removeListener("response", onResponse);
      http2Stream.removeListener("close", onClose);
      client.socket?.removeListener("timeout", onSocketTimeout);

      const shouldDestroy = config.http2Sessions.freed(key, client);
      if (shouldDestroy) client.destroy();

      // Handle when the server closes the stream without responding.
      return reject(
        new ConnectionError(
          req,
          `Connection closed without response from ${url.host}`,
          cause
        )
      );
    };

    req.signal.on("abort", onAbort);
    http2Stream.once("error", onRequestError);
    http2Stream.once("response", onResponse);
    http2Stream.once("close", onClose);
    client.socket.once("timeout", onSocketTimeout);
    config.http2Sessions.used(key, client);

    return pipelineRequest(req, http2Stream, reject);
  });
}

/**
 * Configure HTTP version negotiation.
 */
export enum NegotiateHttpVersion {
  HTTP1_ONLY,
  HTTP2_FOR_HTTPS,
  HTTP2_ONLY,
}

export type CreateNetConnection = (
  options: NetConnectOpts
) => Socket | Promise<Socket>;
export type CreateTlsConnection = (
  options: TlsConnectOpts
) => TLSSocket | Promise<TLSSocket>;
export type CreateHttp2Connection = (
  authority: URL,
  socket: Socket | TLSSocket
) => ClientHttp2Session | Promise<ClientHttp2Session>;

export type LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (err: Error | null, address: string, family: number) => void
) => void;

/**
 * Node.js HTTP request options.
 */
export interface TransportOptions {
  keepAlive?: number;
  idleSocketTimeout?: number;
  idleRequestTimeout?: number;
  servername?: string;
  rejectUnauthorized?: boolean;
  negotiateHttpVersion?: NegotiateHttpVersion;
  ca?: string | Buffer | Array<string | Buffer>;
  cert?: string | Buffer;
  key?: string | Buffer;
  secureContext?: SecureContext;
  secureProtocol?: string;
  secureOptions?: number;
  tlsSockets?: ConnectionManager<TLSSocket>;
  netSockets?: ConnectionManager<Socket>;
  http2Sessions?: ConnectionManager<ClientHttp2Session>;
  lookup?: LookupFunction;
  createHttp2Connection?: CreateHttp2Connection;
  createNetConnection?: CreateNetConnection;
  createTlsConnection?: CreateTlsConnection;
}

/**
 * Custom abort error instance.
 */
export class AbortError extends Error {
  code = "EABORT";

  constructor(public request: Request, message: string) {
    super(message);
  }
}

const DEFAULT_KEEP_ALIVE = 5_000; // 5 seconds.
const DEFAULT_IDLE_REQUEST_TIMEOUT = 30_000; // 30 seconds.
const DEFAULT_IDLE_SOCKET_TIMEOUT = 300_000; // 5 minutes.

/**
 * Shared configuration options during request execution.
 */
interface TransportConfig {
  keepAlive: number;
  idleSocketTimeout: number;
  idleRequestTimeout: number;
  tlsSockets: ConnectionManager<TLSSocket>;
  netSockets: ConnectionManager<Socket>;
  http2Sessions: ConnectionManager<ClientHttp2Session>;
}

function optionsToConfig(options: TransportOptions): TransportConfig {
  const {
    keepAlive = DEFAULT_KEEP_ALIVE,
    idleSocketTimeout = DEFAULT_IDLE_SOCKET_TIMEOUT,
    idleRequestTimeout = DEFAULT_IDLE_REQUEST_TIMEOUT,
    tlsSockets = new SocketConnectionManager<TLSSocket>(),
    netSockets = new SocketConnectionManager<Socket>(),
    http2Sessions = new Http2ConnectionManager(),
  } = options;

  return {
    keepAlive,
    idleSocketTimeout,
    idleRequestTimeout,
    tlsSockets,
    netSockets,
    http2Sessions,
  };
}

/**
 * Forward request over HTTP1/1 or HTTP2, with TLS support.
 */
export function transport(
  options: TransportOptions = {}
): (req: Request, next: () => Promise<Response>) => Promise<Response> {
  const config = optionsToConfig(options);
  const { netSockets, tlsSockets, http2Sessions } = config;
  const {
    lookup = dnsLookup,
    createNetConnection = defaultNetConnect,
    createTlsConnection = defaultTlsConnect,
    createHttp2Connection = defaultHttp2Connect,
    negotiateHttpVersion = NegotiateHttpVersion.HTTP2_FOR_HTTPS,
  } = options;

  return async (req, next) => {
    const url = new URL(req.url, "http://localhost");
    const { hostname, protocol } = url;

    if (req.signal.aborted) {
      throw new AbortError(req, "Request has been aborted");
    }

    if (protocol === "http:") {
      const port = Number(url.port) || 80;
      const connectionKey = `${hostname}:${port}:${negotiateHttpVersion}`;

      if (negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY) {
        const existingClient = http2Sessions.free(connectionKey);

        if (existingClient) {
          return execHttp2(connectionKey, existingClient, req, url, config);
        }
      }

      const socket = await netSockets.ready(connectionKey, (socket) => {
        if (socket) return socket;

        return netSockets.creating(connectionKey, async () => {
          const socket = await createNetConnection({
            host: hostname,
            port,
            lookup,
          });
          setupSocket(netSockets, connectionKey, socket, config);
          return socket;
        });
      });

      // Claim net socket for usage after `ready`.
      netSockets.used(connectionKey, socket);

      // Use existing HTTP2 session in HTTP2-only mode.
      if (negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY) {
        const client = await http2Sessions.ready(
          connectionKey,
          (existingClient) => {
            if (existingClient) {
              netSockets.freed(connectionKey, socket);
              return existingClient;
            }

            return http2Sessions.creating(connectionKey, async () => {
              const client = await createHttp2Connection(url, socket);
              setupHttp2Client(connectionKey, client, config);
              return client;
            });
          }
        );

        return execHttp2(connectionKey, client, req, url, config);
      }

      return execHttp1(req, url, socket, config);
    }

    // Optionally negotiate HTTP2 connection.
    if (protocol === "https:") {
      const {
        ca,
        cert,
        key,
        secureProtocol,
        secureContext,
        secureOptions,
      } = options;
      const port = Number(url.port) || 443;
      const servername =
        options.servername ||
        calculateServerName(hostname, req.headers.get("host"));
      const rejectUnauthorized = options.rejectUnauthorized !== false;
      const connectionKey = `${hostname}:${port}:${negotiateHttpVersion}:${servername}:${rejectUnauthorized}:${
        ca || ""
      }:${cert || ""}:${key || ""}:${secureProtocol || ""}`;

      // Use an existing HTTP2 session before making a new attempt.
      if (
        negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY ||
        negotiateHttpVersion === NegotiateHttpVersion.HTTP2_FOR_HTTPS
      ) {
        const existingSession = http2Sessions.free(connectionKey);

        if (existingSession) {
          return execHttp2(connectionKey, existingSession, req, url, config);
        }
      }

      // Use an existing TLS session to speed up handshake.
      const existingSocket = tlsSockets.get(connectionKey);
      const session = existingSocket ? existingSocket.getSession() : undefined;
      const ALPNProtocols =
        negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY
          ? ["h2"]
          : negotiateHttpVersion === NegotiateHttpVersion.HTTP2_FOR_HTTPS
          ? ["h2", "http/1.1"]
          : undefined;

      const socketOptions: TlsConnectOpts = {
        host: hostname,
        port,
        servername,
        rejectUnauthorized,
        ca,
        cert,
        key,
        session,
        secureProtocol,
        secureContext,
        ALPNProtocols,
        lookup,
        secureOptions,
      };

      const socket = await tlsSockets.ready(connectionKey, (socket) => {
        if (socket) return socket;

        return tlsSockets.creating(connectionKey, async () => {
          const socket = await createTlsConnection(socketOptions);
          setupSocket(tlsSockets, connectionKey, socket, config);
          return socket;
        });
      });

      // Claim TLS socket after `ready`.
      tlsSockets.used(connectionKey, socket);

      if (negotiateHttpVersion === NegotiateHttpVersion.HTTP1_ONLY) {
        return execHttp1(req, url, socket, config);
      }

      if (negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY) {
        const client = await http2Sessions.ready(
          connectionKey,
          (existingClient) => {
            if (existingClient) {
              tlsSockets.freed(connectionKey, socket);
              return existingClient;
            }

            return http2Sessions.creating(connectionKey, async () => {
              const client = await createHttp2Connection(url, socket);
              setupHttp2Client(connectionKey, client, config);
              return client;
            });
          }
        );

        return execHttp2(connectionKey, client, req, url, config);
      }

      return new Promise<HttpResponse | Http2Response>((resolve, reject) => {
        const onClose = () => {
          socket.removeListener("error", onError);
          socket.removeListener("connect", onConnect);

          return reject(new ALPNError(req, "TLS connection closed early"));
        };

        const onError = (err: Error) => {
          socket.removeListener("connect", onConnect);
          socket.removeListener("close", onClose);

          return reject(
            new ConnectionError(
              req,
              `Unable to connect to ${hostname}:${port}`,
              err
            )
          );
        };

        // Execute HTTP connection according to negotiated ALPN protocol.
        const onConnect = () => {
          socket.removeListener("error", onError);
          socket.removeListener("close", onClose);

          // Workaround for https://github.com/nodejs/node/pull/32958/files#r418695485.
          (socket as any).secureConnecting = false;

          // Successfully negotiated HTTP2 connection.
          if (socket.alpnProtocol === "h2") {
            return resolve(
              http2Sessions
                .ready(connectionKey, (existingClient) => {
                  if (existingClient) {
                    tlsSockets.freed(connectionKey, socket);
                    return existingClient;
                  }

                  return http2Sessions.creating(connectionKey, async () => {
                    const client = await createHttp2Connection(url, socket);
                    setupHttp2Client(connectionKey, client, config);
                    return client;
                  });
                })
                .then((client) =>
                  execHttp2(connectionKey, client, req, url, config)
                )
            );
          }

          if (socket.alpnProtocol === "http/1.1" || !socket.alpnProtocol) {
            return resolve(execHttp1(req, url, socket, config));
          }

          return reject(
            new ALPNError(
              req,
              `Unknown ALPN protocol negotiated: ${socket.alpnProtocol}`
            )
          );
        };

        // Existing socket may already have negotiated ALPN protocol.
        // Can be `null`, a string, or `false` when no protocol negotiated.
        if (socket.alpnProtocol != null) return onConnect();

        socket.once("secureConnect", onConnect);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
    }

    return next();
  };
}

/**
 * Setup the socket with the connection manager.
 *
 * Ref: https://github.com/nodejs/node/blob/531b4bedcac14044f09129ffb65dab71cc2707d9/lib/_http_agent.js#L254
 */
function setupSocket<T extends Socket | TLSSocket>(
  manager: ConnectionManager<T>,
  key: string,
  socket: T,
  config: TransportConfig
) {
  const onFree = () => {
    socket.setTimeout(config.idleSocketTimeout);

    const shouldDestroy = manager.freed(key, socket);
    if (shouldDestroy) socket.destroy();
  };

  const cleanup = () => {
    socket.removeListener("free", onFree);
    socket.removeListener("close", cleanup);
    socket.removeListener("error", cleanup);
    socket.removeListener("timeout", onTimeout);
    manager.delete(key, socket);
  };

  const onTimeout = () => {
    socket.destroy();
    return cleanup();
  };

  socket.on("free", onFree);
  socket.once("close", cleanup);
  socket.once("error", cleanup);
  socket.once("timeout", onTimeout);

  socket.setTimeout(config.idleSocketTimeout);
  if (config.keepAlive > 0) socket.setKeepAlive(true, config.keepAlive);
}

/**
 * Set up a HTTP2 working session.
 */
function setupHttp2Client(
  key: string,
  client: ClientHttp2Session,
  config: TransportConfig
) {
  const cleanup = () => {
    client.removeListener("error", cleanup);
    client.removeListener("goaway", cleanup);
    client.removeListener("close", cleanup);
    config.http2Sessions.delete(key, client);
  };

  client.once("error", cleanup);
  client.once("goaway", cleanup);
  client.once("close", cleanup);
}

/**
 * Ref: https://github.com/nodejs/node/blob/5823938d156f4eb6dc718746afbf58f1150f70fb/lib/_http_agent.js#L231
 */
function calculateServerName(hostname: string, hostHeader: string | null) {
  if (!hostHeader) return hostname;
  if (hostHeader.charAt(0) === "[") {
    const index = hostHeader.indexOf("]");
    if (index === -1) return hostHeader;
    return hostHeader.substr(1, index - 1);
  }
  return hostHeader.split(":", 1)[0];
}

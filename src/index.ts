import pump = require("pump");
import { URL } from "url";
import { request as httpRequest, IncomingMessage } from "http";
import { request as httpsRequest, RequestOptions } from "https";
import { BaseError } from "make-error-cause";
import {
  connect as netConnect,
  Socket,
  SocketConnectOpts,
  AddressInfo
} from "net";
import {
  connect as tlsConnect,
  SecureContext,
  TLSSocket,
  ConnectionOptions as TlsConnectOpts
} from "tls";
import {
  connect as http2Connect,
  IncomingHttpHeaders,
  constants as h2constants,
  ClientHttp2Session
} from "http2";
import { PassThrough, Writable } from "stream";
import {
  Request,
  Response,
  CreateBody,
  ResponseOptions,
  HeadersInit
} from "servie/dist/node";
import { useRawBody } from "servie/dist/common";

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
 * Track HTTP connections for reuse.
 */
export class ConnectionManager<T> {
  connections = new Map<string, T>();

  get(key: string) {
    return this.connections.get(key);
  }

  set(key: string, connection: T) {
    if (this.connections.has(key)) {
      throw new TypeError("Connection exists for key");
    }

    this.connections.set(key, connection);
    return connection;
  }

  delete(key: string, connection: T) {
    const existing = this.connections.get(key);

    if (existing !== connection) {
      throw new TypeError("Connection for key does not match");
    }

    this.connections.delete(key);
    return connection;
  }
}

export interface ConcurrencyConnectionManagerOptions {
  maxConnections?: number;
  maxFreeConnections?: number;
}

export class ConnectionSet<T> {
  used = new Set<T>();
  free = new Set<T>();
  pend: Array<(connection?: T) => void> = [];
}

/**
 * Manage HTTP connection reuse.
 */
export class ConcurrencyConnectionManager<T> extends ConnectionManager<
  ConnectionSet<T>
> {
  constructor(
    public maxFreeConnections = 256,
    public maxConnections = Infinity
  ) {
    super();
  }

  /**
   * Create a new connection.
   */
  ready(key: string, onReady: (existingConnection?: T) => void): void {
    const pool = this.get(key);

    // No pool, zero connections.
    if (!pool) return onReady();

    // Reuse free connections first.
    if (pool.free.size) return onReady(this.getFreeConnection(key));

    // Add to "pending" queue.
    if (pool.used.size >= this.maxConnections) {
      pool.pend.push(onReady);
      return;
    }

    // Allow a new connection.
    return onReady();
  }

  getUsedConnection(key: string): T | undefined {
    const pool = this.get(key);
    if (pool) return pool.used.values().next().value;
  }

  getFreeConnection(key: string): T | undefined {
    const pool = this.get(key);
    if (pool) return pool.free.values().next().value;
  }

  use(key: string, connection: T): void {
    const pool = this.get(key) || this.set(key, new ConnectionSet<T>());
    pool.free.delete(connection);
    pool.used.add(connection);
  }

  freed(key: string, connection: T, discard: () => void): void {
    const pool = this.get(key);
    if (!pool) return;

    // Remove from any possible "used".
    pool.used.delete(connection);
    pool.free.add(connection);

    // Discard when too many freed connections.
    if (pool.free.size >= this.maxFreeConnections) return discard();

    // Immediately send for connection.
    if (pool.pend.length) {
      const onReady = pool.pend.shift()!;
      return onReady(connection);
    }
  }

  remove(key: string, connection: T): void {
    const pool = this.get(key);
    if (!pool) return;

    // Delete connection from pool.
    if (pool.used.has(connection)) pool.used.delete(connection);
    if (pool.free.has(connection)) pool.free.delete(connection);

    // Remove connection manager from pooling.
    if (!pool.free.size && !pool.used.size && !pool.pend.length) {
      this.delete(key, pool);
    }
  }
}

/**
 * Configure HTTP version negotiation.
 */
export enum NegotiateHttpVersion {
  HTTP1_ONLY,
  HTTP2_FOR_HTTPS,
  HTTP2_ONLY
}

/**
 * Write Servie body to node.js stream.
 */
function pumpBody(
  req: Request,
  stream: Writable,
  onError: (err: Error) => void
) {
  const body = useRawBody(req);

  if (Buffer.isBuffer(body) || typeof body === "string" || body === null) {
    stream.end(body);
  } else {
    pump(body, stream, onError);
  }
}

// Global connection caches.
const globalNetConnections = new ConcurrencyConnectionManager<Socket>();
const globalTlsConnections = new ConcurrencyConnectionManager<TLSSocket>();
const globalHttp2Connections = new ConnectionManager<ClientHttp2Session>();

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
  keepAlive: number,
  socket: Socket | TLSSocket
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const encrypted = url.protocol === "https:";
    const request: typeof httpRequest = encrypted ? httpsRequest : httpRequest;

    const arg: RequestOptions = {
      protocol: url.protocol,
      host: url.hostname,
      port: url.port,
      defaultPort: encrypted ? 443 : 80, // Specify to avoid `Host` header issues.
      method: req.method,
      path: url.pathname,
      headers: req.headers.asObject(),
      auth:
        url.username || url.password
          ? `${url.username}:${url.password}`
          : undefined,
      createConnection: () => socket
    };

    const rawRequest = request(arg);
    const requestStream = new PassThrough();

    // Handle abort events correctly.
    req.signal.on("abort", () => {
      socket.emit("agentRemove"); // `abort` destroys the connection with no event.
      rawRequest.abort();
    });

    // Reuse HTTP connections where possible.
    if (keepAlive > 0) {
      rawRequest.shouldKeepAlive = true;
      rawRequest.setHeader("Connection", "keep-alive");
    }

    // Trigger unavailable error when node.js errors before response.
    function onRequestError(err: Error) {
      return reject(
        new ConnectionError(req, `Unable to connect to ${url.host}`, err)
      );
    }

    // Track the node.js response.
    function onResponse(rawResponse: IncomingMessage) {
      // Trailers are populated on "end".
      const trailer = new Promise<HeadersInit>(resolve => {
        rawResponse.once("end", () => resolve(rawResponse.trailers));
      });

      // Replace request error listener behaviour.
      rawRequest.removeListener("error", onRequestError);
      rawRequest.on("error", err => req.signal.emit("error", err));

      const {
        address: localAddress,
        port: localPort
      } = rawRequest.connection.address() as AddressInfo;

      const {
        address: remoteAddress,
        port: remotePort
      } = rawResponse.connection.address() as AddressInfo;

      let bytesTransferred = 0;
      req.signal.emit("responseStarted");

      // Track response progress.
      rawResponse.on("data", (chunk: Buffer) => {
        req.signal.emit("responseBytes", (bytesTransferred += chunk.length));
      });

      rawResponse.once("end", () => {
        req.signal.emit("responseEnded");
      });

      const res = new HttpResponse(rawResponse.pipe(new PassThrough()), {
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
          encrypted
        },
        httpVersion: rawResponse.httpVersion
      });

      return resolve(res);
    }

    rawRequest.once("error", onRequestError);
    rawRequest.once("response", onResponse);

    let bytesTransferred = 0;
    req.signal.emit("requestStarted");

    // Track request upload progress.
    requestStream.on("data", (chunk: Buffer) => {
      req.signal.emit("requestBytes", (bytesTransferred += chunk.length));
    });

    pump(requestStream, rawRequest, err => {
      if (err) req.signal.emit("error", err);
      req.signal.emit("requestEnded");
    });

    return pumpBody(req, requestStream, reject);
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
  req: Request,
  url: URL,
  client: ClientHttp2Session
): Promise<Http2Response> {
  return new Promise<Http2Response>((resolve, reject) => {
    // HTTP2 formatted headers.
    const headers = Object.assign(req.headers.asObject(), {
      [h2constants.HTTP2_HEADER_PATH]: url.pathname,
      [h2constants.HTTP2_HEADER_METHOD]: req.method
    });

    const http2Stream = client.request(headers, { endStream: false });
    const requestStream = new PassThrough();

    ref(client.socket); // Request ref tracking.

    // Track when stream finishes.
    function onClose() {
      req.signal.emit("requestEnded");
      unref(client.socket);
    }

    // Trigger unavailable error when node.js errors before response.
    function onRequestError(err: Error) {
      return reject(
        new ConnectionError(req, `Unable to connect to ${url.host}`, err)
      );
    }

    function onResponse(headers: IncomingHttpHeaders) {
      const encrypted = (client.socket as TLSSocket).encrypted === true;
      const {
        localAddress,
        localPort,
        remoteAddress = "",
        remotePort = 0
      } = client.socket;

      // Replace request error listener behaviour with proxy.
      http2Stream.removeListener("error", onRequestError);
      http2Stream.on("error", err => req.signal.emit("error", err));

      let bytesTransferred = 0;
      req.signal.emit("responseStarted");

      // Track response progress.
      http2Stream.on("data", (chunk: Buffer) => {
        req.signal.emit("responseBytes", (bytesTransferred += chunk.length));
      });

      http2Stream.once("end", () => {
        req.signal.emit("responseEnded");
      });

      const res = new Http2Response(http2Stream.pipe(new PassThrough()), {
        status: Number(headers[h2constants.HTTP2_HEADER_STATUS]),
        statusText: "",
        url: req.url,
        httpVersion: "2.0",
        headers,
        connection: {
          localAddress,
          localPort,
          remoteAddress,
          remotePort,
          encrypted
        }
      });

      return resolve(res);
    }

    http2Stream.once("error", onRequestError);
    http2Stream.once("close", onClose);
    http2Stream.once("response", onResponse);

    let bytesTransferred = 0;
    req.signal.emit("requestStarted");
    req.signal.on("abort", () => http2Stream.destroy());

    // Track request upload progress.
    requestStream.on("data", (chunk: Buffer) => {
      req.signal.emit("requestBytes", (bytesTransferred += chunk.length));
    });

    pump(requestStream, http2Stream, () => {
      req.signal.emit("requestEnded");
    });

    return pumpBody(req, requestStream, reject);
  });
}

/**
 * Node.js HTTP request options.
 */
export interface TransportOptions {
  keepAlive?: number;
  servername?: string;
  rejectUnauthorized?: boolean;
  ca?: string | Buffer | Array<string | Buffer>;
  cert?: string | Buffer;
  key?: string | Buffer;
  secureContext?: SecureContext;
  secureProtocol?: string;
  negotiateHttpVersion?: NegotiateHttpVersion;
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

/**
 * Forward request over HTTP1/1 or HTTP2, with TLS support.
 */
export function transport(options: TransportOptions = {}) {
  const {
    keepAlive = 5000, // Default to keeping a connection open briefly.
    negotiateHttpVersion = NegotiateHttpVersion.HTTP2_FOR_HTTPS
  } = options;

  // TODO: Allow configuration in options.
  const tlsConnections = globalTlsConnections;
  const netConnections = globalNetConnections;
  const http2Connections = globalHttp2Connections;

  return async function(
    req: Request,
    next: () => Promise<HttpResponse>
  ): Promise<HttpResponse> {
    const url = new URL(req.url, "http://localhost");
    const { hostname: host, protocol } = url;

    if (req.signal.aborted) {
      throw new AbortError(req, "Request has been aborted");
    }

    if (protocol === "http:") {
      const port = Number(url.port) || 80;
      const connectionKey = `${host}:${port}:${negotiateHttpVersion}`;

      // Use existing HTTP2 session in HTTP2 mode.
      if (negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY) {
        const existingSession = http2Connections.get(connectionKey);

        if (existingSession) return execHttp2(req, url, existingSession);
      }

      return new Promise<HttpResponse>(resolve => {
        return netConnections.ready(connectionKey, freeSocket => {
          const socketOptions: SocketConnectOpts = { host, port };
          const socket =
            freeSocket ||
            setupSocket(
              connectionKey,
              keepAlive,
              netConnections,
              netConnect(socketOptions)
            );

          socket.ref();
          netConnections.use(connectionKey, socket);

          if (negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY) {
            const authority = `${protocol}//${host}:${port}`;
            const client = manageHttp2(
              authority,
              connectionKey,
              keepAlive,
              http2Connections,
              socket
            );

            return resolve(execHttp2(req, url, client));
          }

          return resolve(execHttp1(req, url, keepAlive, socket));
        });
      });
    }

    // Optionally negotiate HTTP2 connection.
    if (protocol === "https:") {
      const { ca, cert, key, secureProtocol, secureContext } = options;
      const port = Number(url.port) || 443;
      const servername =
        options.servername ||
        calculateServerName(host, req.headers.get("host"));
      const rejectUnauthorized = options.rejectUnauthorized !== false;
      const connectionKey = `${host}:${port}:${negotiateHttpVersion}:${servername}:${rejectUnauthorized}:${ca ||
        ""}:${cert || ""}:${key || ""}:${secureProtocol || ""}`;

      // Use an existing TLS session to speed up handshake.
      const existingSocket =
        tlsConnections.getFreeConnection(connectionKey) ||
        tlsConnections.getUsedConnection(connectionKey);
      const session = existingSocket ? existingSocket.getSession() : undefined;

      const socketOptions: TlsConnectOpts = {
        host,
        port,
        servername,
        rejectUnauthorized,
        ca,
        cert,
        key,
        session,
        secureProtocol,
        secureContext
      };

      // Use any existing HTTP2 session.
      if (
        negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY ||
        negotiateHttpVersion === NegotiateHttpVersion.HTTP2_FOR_HTTPS
      ) {
        const existingSession = http2Connections.get(connectionKey);

        if (existingSession) return execHttp2(req, url, existingSession);
      }

      return new Promise<HttpResponse>((resolve, reject) => {
        // Set up ALPN protocols for connection negotiation.
        if (negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY) {
          socketOptions.ALPNProtocols = ["h2"];
        } else if (
          negotiateHttpVersion === NegotiateHttpVersion.HTTP2_FOR_HTTPS
        ) {
          socketOptions.ALPNProtocols = ["h2", "http/1.1"];
        }

        return tlsConnections.ready(connectionKey, freeSocket => {
          const socket =
            freeSocket ||
            setupSocket(
              connectionKey,
              keepAlive,
              tlsConnections,
              tlsConnect(socketOptions)
            );

          socket.ref();
          tlsConnections.use(connectionKey, socket);

          if (negotiateHttpVersion === NegotiateHttpVersion.HTTP1_ONLY) {
            return resolve(execHttp1(req, url, keepAlive, socket));
          }

          if (negotiateHttpVersion === NegotiateHttpVersion.HTTP2_ONLY) {
            const client = manageHttp2(
              `${protocol}//${host}:${port}`,
              connectionKey,
              keepAlive,
              http2Connections,
              socket
            );

            return resolve(execHttp2(req, url, client));
          }

          // Execute HTTP connection according to negotiated ALPN protocol.
          const onConnect = () => {
            const alpnProtocol: string | false = (socket as any).alpnProtocol;

            // Successfully negotiated HTTP2 connection.
            if (alpnProtocol === "h2") {
              const existingClient = http2Connections.get(connectionKey);

              if (existingClient) {
                socket.destroy(); // Destroy socket in case of TLS connection race.

                return resolve(execHttp2(req, url, existingClient));
              }

              const client = manageHttp2(
                `${protocol}//${host}:${port}`,
                connectionKey,
                keepAlive,
                http2Connections,
                socket
              );

              return resolve(execHttp2(req, url, client));
            }

            if (alpnProtocol === "http/1.1" || alpnProtocol === false) {
              return resolve(execHttp1(req, url, keepAlive, socket));
            }

            return reject(
              new ALPNError(
                req,
                `Unknown ALPN protocol negotiated: ${alpnProtocol}`
              )
            );
          };

          // Existing socket may already have negotiated ALPN protocol.
          if ((socket as any).alpnProtocol !== null) return onConnect();

          // Handle TLS socket connection.
          socket.once("secureConnect", onConnect);

          // Handle socket connection issues.
          socket.once("error", (err: Error) => {
            return reject(
              new ConnectionError(
                req,
                `Unable to connect to ${host}:${port}`,
                err
              )
            );
          });
        });
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
  key: string,
  keepAlive: number,
  manager: ConcurrencyConnectionManager<T>,
  socket: T
) {
  const onFree = () => {
    if (keepAlive > 0) {
      socket.setKeepAlive(true, keepAlive);
      socket.unref();
    }

    manager.freed(key, socket, () => socket.destroy());
  };

  const onClose = () => manager.remove(key, socket);

  const onRemove = () => {
    socket.removeListener("free", onFree);
    socket.removeListener("close", onClose);
    manager.remove(key, socket);
  };

  socket.on("free", onFree);
  socket.once("close", onClose);
  socket.once("agentRemove", onRemove);

  return socket;
}

/**
 * Set up a HTTP2 working session.
 */
function manageHttp2<T extends Socket | TLSSocket>(
  authority: string,
  key: string,
  keepAlive: number,
  manager: ConnectionManager<ClientHttp2Session>,
  socket: T
) {
  // TODO: Fix node.js types.
  const connectOptions: any = { createConnection: () => socket };
  const client = http2Connect(authority, connectOptions);

  manager.set(key, client);
  client.once("close", () => manager.delete(key, client));
  client.setTimeout(keepAlive, () => client.close());

  return client;
}

/**
 * Track socket usage.
 */
const SOCKET_REFS = new WeakMap<Socket | TLSSocket, number>();

/**
 * Track socket refs.
 */
function ref(socket: Socket | TLSSocket) {
  const count = SOCKET_REFS.get(socket) || 0;
  if (count === 0) socket.ref();
  SOCKET_REFS.set(socket, count + 1);
}

/**
 * Track socket unrefs and globally unref.
 */
function unref(socket: Socket | TLSSocket) {
  const count = SOCKET_REFS.get(socket);
  if (!count) return;
  if (count === 1) {
    socket.unref();
    SOCKET_REFS.delete(socket);
    return;
  }
  SOCKET_REFS.set(socket, count - 1);
}

/**
 * Ref: https://github.com/nodejs/node/blob/5823938d156f4eb6dc718746afbf58f1150f70fb/lib/_http_agent.js#L231
 */
function calculateServerName(host: string, hostHeader: string | null) {
  if (!hostHeader) return host;
  if (hostHeader.charAt(0) === "[") {
    const index = hostHeader.indexOf("]");
    if (index === -1) return hostHeader;
    return hostHeader.substr(1, index - 1);
  }
  return hostHeader.split(":", 1)[0];
}

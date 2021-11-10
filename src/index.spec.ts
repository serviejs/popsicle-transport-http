import { join } from "path";
import { readFileSync, createReadStream } from "fs";
import { Request, AbortController } from "servie/dist/node";
import {
  transport,
  Http2ConnectionManager,
  SocketConnectionManager,
  Http2Response,
  NegotiateHttpVersion,
  defaultHttp2Connect,
  defaultTlsConnect,
  defaultNetConnect,
  ConnectionError,
} from "./index";
import { server as httpServer } from "./test-server/http";
import { server as httpsServer } from "./test-server/https";
import {
  server as http2Server,
  tlsServer as http2TlsServer,
} from "./test-server/http2";
import type { Socket, AddressInfo } from "net";
import type { TLSSocket } from "tls";

const ca = readFileSync(join(__dirname, "./test-server/support/ca-crt.pem"));

describe("popsicle transport http", () => {
  let TEST_HTTP_URL: string;
  let TEST_HTTPS_URL: string;
  let TEST_HTTP2_URL: string;
  let TEST_HTTP2_TLS_URL: string;

  beforeAll(() => {
    const httpAddress = httpServer.listen(0).address() as AddressInfo;
    const httpsAddress = httpsServer.listen(0).address() as AddressInfo;
    const http2Address = http2Server.listen(0).address() as AddressInfo;
    const http2TlsAddress = http2TlsServer.listen(0).address() as AddressInfo;

    TEST_HTTP_URL = `http://localhost:${httpAddress.port}`;
    TEST_HTTPS_URL = `https://localhost:${httpsAddress.port}`;
    TEST_HTTP2_URL = `http://localhost:${http2Address.port}`;
    TEST_HTTP2_TLS_URL = `https://localhost:${http2TlsAddress.port}`;
  });

  afterAll(() => {
    httpServer.close();
    httpsServer.close();
    http2Server.close();
    http2TlsServer.close();
  });

  const done = () => {
    throw new TypeError("Invalid request");
  };

  it("should return 2xx statuses", async () => {
    const res = await transport()(
      new Request(`${TEST_HTTP_URL}/status/204`),
      done
    );

    expect(res.ok).toEqual(true);
    expect(res.status).toEqual(204);
    expect(res.statusText).toEqual("No Content");
  });

  it("should return 4xx statuses", async () => {
    const res = await transport()(
      new Request(`${TEST_HTTP_URL}/status/404`),
      done
    );

    expect(res.ok).toEqual(false);
    expect(res.status).toEqual(404);
    expect(res.statusText).toEqual("Not Found");
  });

  it("should return 5xx statuses", async () => {
    const res = await transport()(
      new Request(`${TEST_HTTP_URL}/status/500`),
      done
    );

    expect(res.ok).toEqual(false);
    expect(res.status).toEqual(500);
    expect(res.statusText).toEqual("Internal Server Error");
  });

  it("should send path without query", async () => {
    const req = new Request(`${TEST_HTTP_URL}/url`);
    const res = await transport()(req, done);

    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("/url");
  });

  it("should send query params", async () => {
    const req = new Request(`${TEST_HTTP_URL}/url?test=true`);
    const res = await transport()(req, done);

    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("/url?test=true");
  });

  it("should send post data", async () => {
    const req = new Request(`${TEST_HTTP_URL}/echo`, {
      method: "POST",
      body: "example data",
      headers: {
        "content-type": "application/octet-stream",
      },
    });

    const res = await transport()(req, done);

    expect(res.status).toEqual(200);
    expect(res.statusText).toEqual("OK");
    expect(res.headers.get("Content-Type")).toEqual("application/octet-stream");
    expect(await res.text()).toEqual("example data");
  });

  it("should send arraybuffer", async () => {
    const buffer = new ArrayBuffer(3);

    const body = new Uint8Array(buffer);
    body.set([1, 2, 3]);

    const req = new Request(`${TEST_HTTP_URL}/echo`, {
      method: "POST",
      body: buffer,
    });

    const res = await transport()(req, done);

    expect(res.status).toEqual(200);
    expect(res.statusText).toEqual("OK");
    expect(res.headers.get("Content-Type")).toEqual("application/octet-stream");
    expect(await res.arrayBuffer()).toEqual(buffer);
  });

  it("should send stream data", async () => {
    const req = new Request(`${TEST_HTTP_URL}/echo`, {
      method: "POST",
      body: createReadStream(join(__dirname, "../README.md")),
    });

    const res = await transport()(req, done);

    expect(res.status).toEqual(200);
    expect(res.statusText).toEqual("OK");
    expect(res.headers.get("Content-Type")).toEqual("application/octet-stream");
    expect(await res.text()).toContain("Popsicle Transport HTTP");
  });

  it("should abort before it starts", async () => {
    const controller = new AbortController();
    const req = new Request(`${TEST_HTTP_URL}/echo`, {
      signal: controller.signal,
    });

    controller.abort();

    expect.assertions(1);

    try {
      await transport()(req, done);
    } catch (err) {
      if (err instanceof Error) {
        expect(err.message).toEqual("Request has been aborted");
      }
    }
  });

  it("should abort mid-request", async () => {
    const controller = new AbortController();
    const req = new Request(`${TEST_HTTP_URL}/download`, controller);
    const res = await transport()(req, done);

    setTimeout(() => controller.abort(), 100);

    expect(await res.text()).toEqual("hello ");
  });

  it("should have no side effects aborting twice", async () => {
    const controller = new AbortController();
    const req = new Request(`${TEST_HTTP_URL}/download`, controller);

    expect.assertions(1);

    controller.abort();
    controller.abort();

    try {
      await transport()(req, done);
    } catch (err) {
      if (err instanceof Error) {
        expect(err.message).toEqual("Request has been aborted");
      }
    }
  });

  it("should emit download progress", async () => {
    const req = new Request(`${TEST_HTTP_URL}/download`);
    const spy = jest.fn();

    const res = await transport()(req, done);

    req.signal.on("responseBytes", spy);

    expect(await res.text()).toEqual("hello world!");

    // Check spy after body has loaded.
    expect(spy).toBeCalledWith(12);
  });

  it("should re-use net socket", async () => {
    const netSockets = new SocketConnectionManager<Socket>();
    const createNetConnection = jest.fn(defaultNetConnect);

    const send = transport({
      createNetConnection,
      netSockets,
    });

    const req = new Request(TEST_HTTP_URL);

    const res1 = await send(req, done);
    expect(res1.status).toEqual(200);
    expect(await res1.text()).toEqual("Success");

    const res2 = await send(req, done);
    expect(res2.status).toEqual(200);
    expect(await res2.text()).toEqual("Success");

    expect(createNetConnection).toBeCalledTimes(1);
  });

  it("should re-use net socket on free", async () => {
    const netSockets = new SocketConnectionManager<Socket>(Infinity, 1);
    const createNetConnection = jest.fn(defaultNetConnect);

    const send = transport({
      netSockets,
      createNetConnection,
    });

    const req = new Request(TEST_HTTP_URL);
    const [res1, res2] = await Promise.all([send(req, done), send(req, done)]);

    expect(res1.status).toEqual(200);
    expect(res2.status).toEqual(200);
    expect(createNetConnection).toBeCalledTimes(1);
  });

  it("should discard net socket at max connection", async () => {
    const netSockets = new SocketConnectionManager<Socket>(0);
    const createNetConnection = jest.fn(defaultNetConnect);

    const send = transport({
      createNetConnection,
      netSockets,
    });

    const req = new Request(TEST_HTTP_URL);

    const res1 = await send(req, done);
    expect(res1.status).toEqual(200);
    expect(await res1.text()).toEqual("Success");

    const res2 = await send(req, done);
    expect(res2.status).toEqual(200);
    expect(await res2.text()).toEqual("Success");

    expect(createNetConnection).toBeCalledTimes(2);
  });

  it("should create new socket without keep alive", async () => {
    const netSockets = new SocketConnectionManager<Socket>();
    const createNetConnection = jest.fn(defaultNetConnect);

    const send = transport({
      keepAlive: -1,
      createNetConnection,
      netSockets,
    });

    const req = new Request(TEST_HTTP_URL);

    const res1 = await send(req, done);
    expect(res1.status).toEqual(200);
    expect(await res1.text()).toEqual("Success");

    const res2 = await send(req, done);
    expect(res2.status).toEqual(200);
    expect(await res2.text()).toEqual("Success");

    expect(createNetConnection).toBeCalledTimes(2);
  });

  it("should create new socket on free without keep alive", async () => {
    const netSockets = new SocketConnectionManager<Socket>(Infinity, 1);
    const createNetConnection = jest.fn(defaultNetConnect);

    const send = transport({
      keepAlive: -1,
      netSockets,
      createNetConnection,
    });

    const req = new Request(TEST_HTTP_URL);
    const [res1, res2] = await Promise.all([send(req, done), send(req, done)]);

    expect(res1.status).toEqual(200);
    expect(res2.status).toEqual(200);
    expect(createNetConnection).toBeCalledTimes(2);
  });

  it("should reject https unauthorized", async () => {
    expect.assertions(1);

    try {
      await transport()(new Request(TEST_HTTPS_URL), done);
    } catch (err) {
      if (err instanceof ConnectionError) {
        expect(err.code).toEqual("EUNAVAILABLE");
      }
    }
  });

  it.skip("should support https ca option", async () => {
    const req = new Request(TEST_HTTPS_URL);
    const res = await transport({ ca })(req, done);

    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("Success");
  });

  it("should support disabling reject unauthorized", async () => {
    const req = new Request(TEST_HTTPS_URL);
    const res = await transport({ rejectUnauthorized: false })(req, done);

    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("Success");
  });

  it("should re-use tls socket", async () => {
    const tlsSockets = new SocketConnectionManager<TLSSocket>();
    const createTlsConnection = jest.fn(defaultTlsConnect);

    const send = transport({
      rejectUnauthorized: false,
      createTlsConnection,
      tlsSockets,
    });

    const req = new Request(TEST_HTTPS_URL);

    const res1 = await send(req, done);
    expect(res1.status).toEqual(200);
    expect(await res1.text()).toEqual("Success");

    const res2 = await send(req, done);
    expect(res2.status).toEqual(200);
    expect(await res2.text()).toEqual("Success");

    expect(createTlsConnection).toBeCalledTimes(1);
  });

  it("should connect to http2 non-tls server", async () => {
    const req = new Request(TEST_HTTP2_URL);
    const res = await transport({
      negotiateHttpVersion: NegotiateHttpVersion.HTTP2_ONLY,
    })(req, done);

    expect(res.status).toEqual(200);
    expect(res).toBeInstanceOf(Http2Response);
    expect(await res.text()).toEqual("Not using TLS");
  });

  it("should connect to http2 server", async () => {
    const req = new Request(TEST_HTTP2_TLS_URL);
    const res = await transport({ rejectUnauthorized: false })(req, done);

    expect(res.status).toEqual(200);
    expect(res).toBeInstanceOf(Http2Response);
    expect(await res.text()).toEqual("Using TLS over HTTP 2.0");
  });

  it("should connect to http2 server using http2 only", async () => {
    const req = new Request(TEST_HTTP2_TLS_URL);
    const res = await transport({
      rejectUnauthorized: false,
      negotiateHttpVersion: NegotiateHttpVersion.HTTP2_ONLY,
    })(req, done);

    expect(res.status).toEqual(200);
    expect(res).toBeInstanceOf(Http2Response);
    expect(await res.text()).toEqual("Using TLS over HTTP 2.0");
  });

  it("should connect to https server using http1 only", async () => {
    const req = new Request(TEST_HTTP2_TLS_URL);
    const res = await transport({
      rejectUnauthorized: false,
      negotiateHttpVersion: NegotiateHttpVersion.HTTP1_ONLY,
    })(req, done);

    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("Using TLS over HTTP 1.1");
  });

  it("should re-use http2 client", async () => {
    const createHttp2Connection = jest.fn(defaultHttp2Connect);

    const send = transport({
      rejectUnauthorized: false,
      http2Sessions: new Http2ConnectionManager(),
      createHttp2Connection,
    });

    const req = new Request(TEST_HTTP2_TLS_URL);
    const res1 = await send(req, done);
    expect(res1.status).toEqual(200);

    const res2 = await send(req, done);
    expect(res2.status).toEqual(200);

    expect(createHttp2Connection).toBeCalledTimes(1);
  });

  it("should re-use http2 client without tls", async () => {
    const createHttp2Connection = jest.fn(defaultHttp2Connect);

    const send = transport({
      http2Sessions: new Http2ConnectionManager(),
      createHttp2Connection,
      negotiateHttpVersion: NegotiateHttpVersion.HTTP2_ONLY,
    });

    const req = new Request(TEST_HTTP2_URL);
    const res1 = await send(req, done);
    expect(res1.status).toEqual(200);

    const res2 = await send(req, done);
    expect(res2.status).toEqual(200);

    expect(createHttp2Connection).toBeCalledTimes(1);
  });

  it("should re-use connection to http2 server", async () => {
    const createHttp2Connection = jest.fn(defaultHttp2Connect);

    const send = transport({
      rejectUnauthorized: false,
      http2Sessions: new Http2ConnectionManager(),
      createHttp2Connection,
    });

    const req = new Request(TEST_HTTP2_TLS_URL);
    const [res1, res2] = await Promise.all([send(req, done), send(req, done)]);

    expect(res1.status).toEqual(200);
    expect(res2.status).toEqual(200);
    expect(createHttp2Connection).toBeCalledTimes(1);
  });

  it("should allow custom dns lookup for http requests", async () => {
    const lookup = jest.fn((hostname, options, callback) =>
      callback(null, "127.0.0.1", 4)
    );

    const send = transport({
      rejectUnauthorized: false,
      lookup,
      netSockets: new SocketConnectionManager(),
    });

    const req = new Request(`${TEST_HTTP_URL}/status/200`);
    const res = await send(req, done);

    expect(res.status).toEqual(200);
    expect(lookup).toBeCalledTimes(1);
  });

  it("should allow custom dns lookup for https requests", async () => {
    const lookup = jest.fn((hostname, options, callback) =>
      callback(null, "127.0.0.1", 4)
    );

    const send = transport({
      rejectUnauthorized: false,
      lookup,
      tlsSockets: new SocketConnectionManager(),
    });

    const req = new Request(`${TEST_HTTPS_URL}/status/200`);
    const res = await send(req, done);

    expect(res.status).toEqual(200);
    expect(lookup).toBeCalledTimes(1);
  });

  it("should allow custom dns lookup for http2 requests", async () => {
    const lookup = jest.fn((hostname, options, callback) =>
      callback(null, "127.0.0.1", 4)
    );

    const send = transport({
      rejectUnauthorized: false,
      lookup,
      tlsSockets: new SocketConnectionManager(),
      http2Sessions: new Http2ConnectionManager(),
    });

    const req = new Request(TEST_HTTP2_TLS_URL);
    const res = await send(req, done);

    expect(res.status).toEqual(200);
    expect(lookup).toBeCalledTimes(1);
  });
});

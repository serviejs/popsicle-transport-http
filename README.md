# Popsicle Transport HTTP

[![NPM version][npm-image]][npm-url]
[![NPM downloads][downloads-image]][downloads-url]
[![Build status][build-image]][build-url]
[![Build coverage][coverage-image]][coverage-url]

> Popsicle transport for sending requests over HTTP1 and HTTP2.

## Installation

```
npm install popsicle-transport-http --save
```

## Usage

```js
import { transport } from "popsicle-transport-http";

const req = new Request("/");
const res = await transport()(req, done);
```

### Transport Options

The `transport` function sends the Servie `Request` to a remote server.

- `keepAlive?: number` Duration to keep connection alive for re-use (default: `5000`)
- `servername?: string` Override remote server name for TLS
- `rejectUnauthorized?: boolean` Rejects unauthorized TLS connections
- `negotiateHttpVersion?: NegotiateHttpVersion` Configure HTTP version negotiation (default: `HTTP2_FOR_HTTPS`)
- `lookup?: DnsLookup` Override default DNS resolution (default: `dns.lookup`)
- TLS options:
  - `ca?: string | Buffer | Array<string | Buffer>` Set TLS CA
  - `cert?: string | Buffer` Set TLS certificate
  - `key?: string | Buffer` Set TLS key
  - `secureContext?: SecureContext` Set TLS secure context
  - `secureProtocol?: string` Set TLS secure protocol
  - `secureOptions?: number` Set TLS secure options
- Custom connection managers (default: `Infinity` active sockets):
  - `tlsSockets?: ConnectionManager<TLSSocket>`
  - `netSockets?: ConnectionManager<Socket>`
  - `http2Sessions?: ConnectionManager<ClientHttp2Session>`
- Custom create connections (all methods support async promises):
  - `createHttp2Connection?: (authority, socket) => ClientHttp2Session`
  - `createNetConnection?: (options) => Socket`
  - `createTlsConnection?: (options) => TLSSocket`

## TypeScript

This project is written using [TypeScript](https://github.com/Microsoft/TypeScript) and publishes the definitions directly to NPM.

## License

MIT

[npm-image]: https://img.shields.io/npm/v/popsicle-transport-http.svg?style=flat
[npm-url]: https://npmjs.org/package/popsicle-transport-http
[downloads-image]: https://img.shields.io/npm/dm/popsicle-transport-http.svg?style=flat
[downloads-url]: https://npmjs.org/package/popsicle-transport-http
[build-image]: https://img.shields.io/github/workflow/status/serviejs/popsicle-transport-http/CI/main
[build-url]: https://github.com/serviejs/popsicle-transport-http/actions/workflows/ci.yml?query=branch%3Amain
[coverage-image]: https://img.shields.io/codecov/c/gh/serviejs/popsicle-transport-http
[coverage-url]: https://codecov.io/gh/serviejs/popsicle-transport-http

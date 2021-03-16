import { createServer, createSecureServer } from "http2";
import { readFileSync } from "fs";
import { join } from "path";

export const server = createServer((req, res) => {
  res.end("Not using TLS");
});

export const tlsServer = createSecureServer(
  {
    key: readFileSync(join(__dirname, "support/server-key.pem")),
    cert: readFileSync(join(__dirname, "support/server-crt.pem")),
    ca: readFileSync(join(__dirname, "support/ca-crt.pem")),
    allowHTTP1: true,
  },
  (req, res) => {
    res.statusCode = 200;
    res.end(`Using TLS over HTTP ${req.httpVersion}`);
  }
);

import {
  createServer,
  createSecureServer,
  Http2ServerRequest,
  Http2ServerResponse,
} from "http2";
import { readFileSync } from "fs";
import { join } from "path";
import { URL } from "url";

const app = (req: Http2ServerRequest, res: Http2ServerResponse) => {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/close") {
    res.destroy();
    return;
  }

  if (url.pathname === "/timeout") {
    return;
  }

  if (url.pathname === "/download") {
    res.setHeader("Content-Length", 12);
    res.write("hello ");

    setTimeout(function () {
      if (res.destroyed) return;

      res.write("world!");
      res.end();
    }, 200);

    return;
  }

  res.end("Success");
};

export const server = createServer(app);

export const tlsServer = createSecureServer(
  {
    key: readFileSync(join(__dirname, "support/server-key.pem")),
    cert: readFileSync(join(__dirname, "support/server-crt.pem")),
    ca: readFileSync(join(__dirname, "support/ca-crt.pem")),
    allowHTTP1: true,
  },
  app
);

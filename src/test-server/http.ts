import { createServer, IncomingMessage, ServerResponse } from "http";
import { createReadStream } from "fs";
import { URL } from "url";
import { createServer as createTlsServer } from "https";
import { readFileSync } from "fs";
import { join } from "path";

const app = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/echo") {
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) res.setHeader(key, value);
    }
    req.pipe(res);
    return;
  }

  if (/\/status\/\d+/.test(url.pathname)) {
    res.statusCode = Number(url.pathname.substr(8));
    res.end();
    return;
  }

  if (url.pathname === "/urandom") {
    createReadStream("/dev/urandom").pipe(res);
    return;
  }

  if (url.pathname === "/download") {
    res.setHeader("Content-Length", 12);
    res.write("hello ");

    setTimeout(function () {
      res.write("world!");
      res.end();
    }, 200);

    return;
  }

  if (url.pathname === "/url") {
    res.end(req.url);
    return;
  }

  if (url.pathname === "/close") {
    res.destroy();
    return;
  }

  if (url.pathname === "/timeout") {
    return;
  }

  res.end("Success");
  return;
};

export const server = createServer(app);

export const tlsServer = createTlsServer(
  {
    key: readFileSync(join(__dirname, "support/server-key.pem")),
    cert: readFileSync(join(__dirname, "support/server-crt.pem")),
    ca: readFileSync(join(__dirname, "support/ca-crt.pem")),
  },
  app
);

import { createServer } from "https";
import { readFileSync } from "fs";
import { join } from "path";
import { URL } from "url";

const options = {
  key: readFileSync(join(__dirname, "support/server-key.pem")),
  cert: readFileSync(join(__dirname, "support/server-crt.pem")),
  ca: readFileSync(join(__dirname, "support/ca-crt.pem")),
};

export const server = createServer(options, function (req, res) {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/close") {
    res.destroy();
    return;
  }

  res.writeHead(200);
  res.end("Success");
});

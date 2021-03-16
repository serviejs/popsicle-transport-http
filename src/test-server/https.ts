import { createServer } from "https";
import { readFileSync } from "fs";
import { join } from "path";

const options = {
  key: readFileSync(join(__dirname, "support/server-key.pem")),
  cert: readFileSync(join(__dirname, "support/server-crt.pem")),
  ca: readFileSync(join(__dirname, "support/ca-crt.pem")),
};

export const server = createServer(options, function (req, res) {
  res.writeHead(200);
  res.end("Success");
});

import { createSecureServer } from "http2";
import { readFileSync } from "fs";
import { join } from "path";

const options = {
  key: readFileSync(join(__dirname, "support/server-key.pem")),
  cert: readFileSync(join(__dirname, "support/server-crt.pem")),
  ca: readFileSync(join(__dirname, "support/ca-crt.pem")),
};

export const server = createSecureServer(options);

server.on("stream", (stream) => {
  stream.respond({
    ":status": 200,
  });
  stream.end("Success");
});

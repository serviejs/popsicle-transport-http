var http2 = require("http2");
var fs = require("fs");
var join = require("path").join;

var options = {
  key: fs.readFileSync(join(__dirname, "support/server-key.pem")),
  cert: fs.readFileSync(join(__dirname, "support/server-crt.pem")),
  ca: fs.readFileSync(join(__dirname, "support/ca-crt.pem")),
};

var server = http2.createSecureServer(options);

server.on("stream", (stream) => {
  stream.respond({
    ":status": 200,
  });
  stream.end("Success");
});

if (!module.parent) {
  server.listen(process.env.HTTP2_PORT || 3000);
}

var express = require("express");
var { createReadStream } = require("fs");

var app = (module.exports = express());

app.all("/echo", function(req, res) {
  res.set(req.headers);
  req.pipe(res);
});

app.get("/status/:status", function(req, res) {
  res.sendStatus(~~req.params.status);
});

app.all("/urandom", function(req, res) {
  createReadStream("/dev/urandom").pipe(res);
});

app.get("/download", function(req, res) {
  res.set("Content-Length", 12);

  res.write("hello ");

  setTimeout(function() {
    res.write("world!");
    res.end();
  }, 200);
});

app.get("/url", function(req, res) {
  res.end(req.url);
});

if (!module.parent) {
  app.listen(process.env.PORT || 3000);
}

const { transport } = require("../dist");
const { Request } = require("servie");

// Facebook is HTTP/2.
transport()(new Request("https://facebook.com")).then(console.log);

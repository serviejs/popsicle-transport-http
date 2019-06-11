import { join } from "path";
import { readFileSync } from "fs";
import { Request, AbortController } from "servie/dist/node";
import { transport } from "./index";

const TEST_HTTP_URL = `http://localhost:${process.env.PORT}`;
const TEST_HTTPS_URL = `https://localhost:${process.env.HTTPS_PORT}`;

describe("popsicle node", () => {
  const done = () => {
    throw new TypeError("Invalid request");
  };

  it("should return 2xx statuses", async () => {
    const res = await transport()(
      new Request(`${TEST_HTTP_URL}/status/204`),
      done
    );

    expect(res.ok).toEqual(true);
    expect(res.status).toEqual(204);
    expect(res.statusText).toEqual("No Content");
  });

  it("should return 4xx statuses", async () => {
    const res = await transport()(
      new Request(`${TEST_HTTP_URL}/status/404`),
      done
    );

    expect(res.ok).toEqual(false);
    expect(res.status).toEqual(404);
    expect(res.statusText).toEqual("Not Found");
  });

  it("should return 5xx statuses", async () => {
    const res = await transport()(
      new Request(`${TEST_HTTP_URL}/status/500`),
      done
    );

    expect(res.ok).toEqual(false);
    expect(res.status).toEqual(500);
    expect(res.statusText).toEqual("Internal Server Error");
  });

  it("should send post data", async () => {
    const req = new Request(`${TEST_HTTP_URL}/echo`, {
      method: "POST",
      body: "example data",
      headers: {
        "content-type": "application/octet-stream"
      }
    });

    const res = await transport()(req, done);

    expect(res.status).toEqual(200);
    expect(res.statusText).toEqual("OK");
    expect(res.headers.get("Content-Type")).toEqual("application/octet-stream");
    expect(await res.text()).toEqual("example data");
  });

  it("should abort before it starts", async () => {
    const controller = new AbortController();
    const req = new Request(`${TEST_HTTP_URL}/echo`, {
      signal: controller.signal
    });

    controller.abort();

    expect.assertions(1);

    try {
      await transport()(req, done);
    } catch (err) {
      expect(err.message).toEqual("Request has been aborted");
    }
  });

  it("should abort mid-request", async () => {
    const controller = new AbortController();
    const req = new Request(`${TEST_HTTP_URL}/download`, controller);
    const res = await transport()(req, done);

    setTimeout(() => controller.abort(), 100);

    expect(await res.text()).toEqual("hello ");
  });

  it("should have no side effects aborting twice", async () => {
    const controller = new AbortController();
    const req = new Request(`${TEST_HTTP_URL}/download`, controller);

    expect.assertions(1);

    controller.abort();
    controller.abort();

    try {
      await transport()(req, done);
    } catch (err) {
      expect(err.message).toEqual("Request has been aborted");
    }
  });

  it("should emit download progress", async () => {
    const req = new Request(`${TEST_HTTP_URL}/download`);
    const spy = jest.fn();

    const res = await transport()(req, done);

    req.signal.on("responseBytes", spy);

    expect(await res.text()).toEqual("hello world!");

    // Check spy after body has loaded.
    expect(spy).toBeCalledWith(12);
  });

  it("should reject https unauthorized", async () => {
    expect.assertions(1);

    try {
      await transport()(new Request(TEST_HTTPS_URL), done);
    } catch (err) {
      expect(err.code).toEqual("EUNAVAILABLE");
    }
  });

  it.skip("should support https ca option", async () => {
    const req = new Request(TEST_HTTPS_URL);
    const ca = readFileSync(join(__dirname, "../scripts/support/ca-crt.pem"));
    const res = await transport({ ca })(req, done);

    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("Success");
  });

  it("should support disabling reject unauthorized", async () => {
    const req = new Request(TEST_HTTPS_URL);
    const res = await transport({ rejectUnauthorized: false })(req, done);

    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("Success");
  });
});

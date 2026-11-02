"use strict";

const util = require("util");
const { AsyncResource } = require("async_hooks");
const { channel } = require("diagnostics_channel");
const { performance } = require("perf_hooks");
const tracing = channel("eris.request.phase");
const Base = require("../structures/Base");
const Crypto = require("crypto");
const DiscordHTTPError = require("../errors/DiscordHTTPError");
const DiscordRESTError = require("../errors/DiscordRESTError");
const Endpoints = require("./Endpoints");
const HTTPS = require("https");
const MultipartData = require("../util/MultipartData");
const SequentialBucket = require("../util/SequentialBucket");
const Zlib = require("zlib");

/**
 * Handles API requests
 */
class RequestHandler {
  constructor(client, options) {
    // [DEPRECATED] Previously forceQueueing
    if (typeof options === "boolean") {
      options = {
        forceQueueing: options,
      };
    }
    this.options = options = Object.assign({
      agent: client.options.agent || null,
      baseURL: Endpoints.BASE_URL,
      decodeReasons: true,
      disableLatencyCompensation: false,
      domain: "discord.com",
      latencyThreshold: client.options.latencyThreshold || 30000,
      ratelimiterOffset: client.options.ratelimiterOffset || 0,
      requestTimeout: client.options.requestTimeout || 15000,
    }, options);

    this._client = client;
    this.userAgent = `DiscordBot (https://github.com/abalabahaha/eris, ${require("../../package.json").version})`;
    this.ratelimits = {};
    this.latencyRef = {
      latency: this.options.ratelimiterOffset,
      raw: new Array(10).fill(this.options.ratelimiterOffset),
      timeOffset: 0,
      timeOffsets: new Array(10).fill(0),
      lastTimeOffsetCheck: 0,
    };
    this.globalBlock = false;
    this.globalRatelimit = false;
    this.readyQueue = [];
    if (this.options.forceQueueing) {
      this.globalBlock = true;
      this._client.once("shardPreReady", () => this.globalUnblock());
    }
  }

  globalUnblock() {
    this.globalBlock = false;
    this.globalRatelimit = false;
    while (this.readyQueue.length > 0) {
      this.readyQueue.shift()();
    }
  }

  /**
   * Make an API request
   * @arg {String} method Uppercase HTTP method
   * @arg {String} url URL of the endpoint
   * @arg {Boolean} [auth] Whether to add the Authorization header and token or not
   * @arg {Object} [body] Request payload
   * @arg {Boolean} [body.rejectOn429] Whether to reject instead of retrying when rate limited
   * @arg {Object} [file] File object
   * @arg {Buffer} file.file A buffer containing file data
   * @arg {String} file.name What to name the file
   * @returns {Promise<Object>} Resolves with the returned JSON data
   */
  request(method, url, auth, body, file, _route, short, _trace) {
    const trace = _trace || { attempts: 0, waits: {}, omitted: 0 };
    trace.attempts++;
    const route = _route || this.routefy(url, method);
    const shouldSkipQueue = this.shouldSkipQueue(method, url);
    let bucket;
    const rejectOn429 = body && body.rejectOn429;
    if (body && Object.prototype.hasOwnProperty.call(body, "rejectOn429")) {
      body = { ...body };
      delete body.rejectOn429;
    }

    const _stackHolder = {}; // Preserve async stack
    Error.captureStackTrace(_stackHolder);

    const requestResource = new AsyncResource("eris.request");
    return new Promise((resolve, reject) => {
      let settled = false;
      let owned = false;
      let release = () => {};
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        release();
        if (owned) { bucket.owners--; owned = false; }
        fn(value);
      };
      const resolveOnce = (value) => finish(resolve, value);
      const rejectOnce = (err) => finish(reject, err);

      let endQueue = () => {};
      const actualCall = async (done) => {
        if (settled) return;
        let released = false;
        const cb = () => { if (!released) { released = true; done(); } };
        release = cb;
        let closed = false;
        endQueue();
        const headers = {
          "User-Agent": this.userAgent,
          "Accept-Encoding": "gzip,deflate",
        };
        let data;
        let finalURL = url;

        try {
          if (auth) {
            headers.Authorization = this._client._token;
          }
          if (body && body.reason) { // Audit log reason sniping
            let unencodedReason = body.reason;
            if (this.options.decodeReasons) {
              try {
                if (unencodedReason.includes("%") && !unencodedReason.includes(" ")) {
                  unencodedReason = decodeURIComponent(unencodedReason);
                }
              } catch (err) {
                this._client.emit("error", err);
              }
            }
            headers["X-Audit-Log-Reason"] = encodeURIComponent(unencodedReason);
            delete body.reason;
          }
          if (file) {
            data = new MultipartData();
            headers["Content-Type"] = "multipart/form-data; boundary=" + data.boundary;

            if (Array.isArray(file)) {
              file.forEach(function (f, i) {
                if (!f.file) {
                  return;
                }
                data.attach(`files[${i}]`, f.file, f.name);
              });
            } else if (file.file) {
              if (method === "POST" && url.endsWith("/stickers")) {
                data.attach("file", file.file, file.name);
              } else {
                data.attach("files[0]", file.file, file.name);
              }
            } else {
              throw new Error("Invalid file object");
            }

            if (body) {
              for (const key in body) {
                data.attach(key, body[key]);
              }
            }

            data = data.finish();
          } else if (body) {
            if (method === "GET" || method === "DELETE") {
              let qs = "";
              Object.keys(body).forEach(function (key) {
                if (body[key] != undefined) {
                  if (Array.isArray(body[key])) {
                    body[key].forEach(function (val) {
                      qs += `&${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
                    });
                  } else {
                    qs += `&${encodeURIComponent(key)}=${encodeURIComponent(body[key])}`;
                  }
                }
              });
              finalURL += "?" + qs.substring(1);
            } else {
              // Replacer function serializes bigints to strings, the format Discord uses
              data = JSON.stringify(body, (k, v) => typeof v === "bigint" ? v.toString() : v);
              headers["Content-Type"] = "application/json";
            }
          }
        } catch (err) {
          cb();
          rejectOnce(err);
          return;
        }

        let req;
        try {
          req = await HTTPS.request({
            method: method,
            host: this.options.domain,
            path: this.options.baseURL + finalURL,
            headers: headers,
            agent: this.options.agent,
          });
        } catch (err) {
          cb();
          rejectOnce(err);
          return;
        }

        let reqError;

        req.once("abort", () => {
          if (closed || settled) return;
          closed = true;
          cb();
          reqError = reqError || new Error(`Request aborted by client on ${method} ${url}`);
          reqError.req = req;
          rejectOnce(reqError);
        }).once("error", (err) => {
          if (closed || settled) return;
          reqError = err;
          req.abort();
        });

        let latency = Date.now();

        req.once("response", (resp) => {
          if (closed || settled) return;
          latency = Date.now() - latency;
          if (!this.options.disableLatencyCompensation) {
            this.latencyRef.raw.push(latency);
            this.latencyRef.latency = this.latencyRef.latency - ~~(this.latencyRef.raw.shift() / 10) + ~~(latency / 10);
          }

          if (this._client.listeners("rawREST").length) {
            /**
             * Fired when the Client's RequestHandler receives a response
             * @event Client#rawREST
             * @prop {Object} [request] The data for the request.
             * @prop {Boolean} request.auth True if the request required an authorization token
             * @prop {Object} [request.body] The request payload
             * @prop {Object} [request.file] The file object sent in the request
             * @prop {Buffer} request.file.file A buffer containing file data
             * @prop {String} request.file.name The name of the file
             * @prop {Number} request.latency The HTTP response latency
             * @prop {String} request.method Uppercase HTTP method
             * @prop {IncomingMessage} request.resp The HTTP response to the request
             * @prop {String} request.route The calculated ratelimiting route for the request
             * @prop {Boolean} request.short Whether or not the request was prioritized in its ratelimiting queue
             * @prop {String} request.url URL of the endpoint
             */
            this._client.emit("rawREST", { method, url, auth, body, file, route, short, resp, latency });
          }

          const headerNow = Date.parse(resp.headers["date"]);
          if (this.latencyRef.lastTimeOffsetCheck < Date.now() - 5000) {
            const timeOffset = headerNow + 500 - (this.latencyRef.lastTimeOffsetCheck = Date.now());
            if (this.latencyRef.timeOffset - this.latencyRef.latency >= this.options.latencyThreshold && timeOffset - this.latencyRef.latency >= this.options.latencyThreshold) {
              this._client.emit("warn", new Error(`Your clock is ${this.latencyRef.timeOffset}ms behind Discord's server clock. Please check your connection and system time.`));
            }
            this.latencyRef.timeOffset = this.latencyRef.timeOffset - ~~(this.latencyRef.timeOffsets.shift() / 10) + ~~(timeOffset / 10);
            this.latencyRef.timeOffsets.push(timeOffset);
          }

          resp.once("aborted", () => {
            if (closed || settled) return;
            closed = true;
            cb();
            reqError = reqError || new Error(`Request aborted by server on ${method} ${url}`);
            reqError.req = req;
            rejectOnce(reqError);
          });

          let response = "";

          let _respStream = resp;
          if (resp.headers["content-encoding"]) {
            if (resp.headers["content-encoding"].includes("gzip")) {
              _respStream = resp.pipe(Zlib.createGunzip());
            } else if (resp.headers["content-encoding"].includes("deflate")) {
              _respStream = resp.pipe(Zlib.createInflate());
            }
          }

          _respStream.on("data", (str) => {
            response += str;
          }).on("error", (err) => {
            if (closed || settled) return;
            reqError = err;
            req.abort();
          }).once("end", () => {
            if (closed || settled) return;
            closed = true;
            const now = Date.now();

            const retryAfter = Number(resp.statusCode === 429 ? resp.headers["x-ratelimit-reset-after"] : (resp.headers["x-ratelimit-reset-after"] || resp.headers["retry-after"])) * 1000;
            if (bucket) {
              if (resp.headers["x-ratelimit-limit"]) {
                bucket.limit = +resp.headers["x-ratelimit-limit"];
              }

              if (method !== "GET" && (resp.headers["x-ratelimit-remaining"] == undefined || resp.headers["x-ratelimit-limit"] == undefined) && bucket.limit !== 1) {
                this._client.emit("debug", `Missing ratelimit headers for SequentialBucket(${bucket.remaining}/${bucket.limit}) with non-default limit\n`
              + `${resp.statusCode} ${resp.headers["content-type"]}: ${method} ${route} | ${resp.headers["cf-ray"]}\n`
              + "x-ratelimit-remaining = " + resp.headers["x-ratelimit-remaining"] + "\n"
              + "x-ratelimit-limit = " + resp.headers["x-ratelimit-limit"] + "\n"
              + "x-ratelimit-reset = " + resp.headers["x-ratelimit-reset"] + "\n"
              + "x-ratelimit-global = " + resp.headers["x-ratelimit-global"]);
              }

              bucket.remaining = resp.headers["x-ratelimit-remaining"] === undefined ? 1 : +resp.headers["x-ratelimit-remaining"] || 0;

              if (retryAfter >= 0) {
                if (resp.statusCode !== 429 && resp.headers["x-ratelimit-global"]) {
                  this.globalBlock = true;
                  this.globalRatelimit = true;
                  setTimeout(() => this.globalUnblock(), retryAfter || 1);
                } else {
                  bucket.reset = (retryAfter || 1) + now;
                }
              } else if (resp.headers["x-ratelimit-reset"]) {
                let resetTime = +resp.headers["x-ratelimit-reset"] * 1000;
                if (route.endsWith("/reactions/:id") && (+resp.headers["x-ratelimit-reset"] * 1000 - headerNow) === 1000) {
                  resetTime = now + 250;
                }
                bucket.reset = Math.max(resetTime - this.latencyRef.latency, now);
              } else {
                bucket.reset = now;
              }

              if (resp.statusCode !== 429) {
                const content = typeof body === "object" ? `${body.content} ` : "";
                this._client.emit("debug", `${content}${now} ${route} ${resp.statusCode}: ${latency}ms (${this.latencyRef.latency}ms avg) | ${bucket.remaining}/${bucket.limit} left | Reset ${bucket.reset} (${bucket.reset - now}ms left)`);
              }
            }

            if (resp.statusCode !== 429 && !bucket && retryAfter >= 0 && resp.headers["x-ratelimit-global"]) {
              this.globalBlock = true;
              this.globalRatelimit = true;
              setTimeout(() => this.globalUnblock(), retryAfter || 1);
            }

            if (resp.statusCode >= 300) {
              if (resp.statusCode === 429) {
                const content = typeof body === "object" ? `${body.content} ` : "";
                let parsed;
                try { parsed = JSON.parse(response); } catch (_) { /* Header fallback. */ }
                const value = parsed == null ? undefined : parsed.retry_after;
                const header = resp.headers["retry-after"];
                const numericHeader = typeof header === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(header.trim()) ? Number(header) : NaN;
                const seconds = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : numericHeader;
                const valid = Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(seconds * 1000);
                const delay = seconds * 1000;
                if (valid && (resp.headers["x-ratelimit-global"] || (parsed && parsed.global === true))) {
                  this.globalBlock = true;
                  this.globalRatelimit = true;
                  setTimeout(() => this.globalUnblock(), delay);
                }
                if (!rejectOn429) {
                  if (!valid) {
                    cb();
                    rejectOnce(new Error("Invalid 429 retry delay"));
                    return;
                  }
                  this._client.emit("debug", `${content}${now} ${route} 429: Retry ${delay}ms`);
                  retry(delay, "429", done, true);
                  return;
                }
              } else if (resp.statusCode === 502) {
                // Preserve the existing reset-on-recursion (unbounded) policy.
                this._client.emit("debug", "A wild 502 appeared! Thanks CloudFlare!");
                cb();
                retry(Math.floor(Math.random() * 1900 + 100), "502", cb, false);
                return;
              }
              cb();

              if (response.length > 0) {
                if (resp.headers["content-type"] === "application/json") {
                  try {
                    response = JSON.parse(response);
                  } catch (err) {
                    rejectOnce(err);
                    return;
                  }
                }
              }

              let { stack } = _stackHolder;
              if (stack.startsWith("Error\n")) {
                stack = stack.substring(6);
              }
              let err;
              if (response && response.code) {
                err = new DiscordRESTError(req, resp, response, stack);
              } else {
                err = new DiscordHTTPError(req, resp, response, stack);
              }
              rejectOnce(err);
              return;
            }

            if (response.length > 0) {
              if (resp.headers["content-type"] === "application/json") {
                try {
                  response = JSON.parse(response);
                } catch (err) {
                  cb();
                  rejectOnce(err);
                  return;
                }
              }
            }

            cb();
            resolveOnce(response || undefined);
          });
        });

        req.setTimeout(this.options.requestTimeout, () => {
          if (closed || settled) return;
          reqError = new Error(`Request timed out (>${this.options.requestTimeout}ms) on ${method} ${url}`);
          req.abort();
        });

        if (Array.isArray(data)) {
          for (const chunk of data) {
            req.write(chunk);
          }
          req.end();
        } else {
          req.end(data);
        }
      };

      const run = (done) => {
        if (settled) return;
        // Recheck after bucket wakeups: another route may have blocked globally.
        if (this.globalBlock && auth && !(this.globalRatelimit && shouldSkipQueue)) {
          const endReady = this.#phase(trace, "ready_queue");
          const resource = new AsyncResource("eris.readyQueue");
          this.readyQueue.push(() => {
            try { resource.runInAsyncScope(() => { endReady(); run(done); }); }
            finally { resource.emitDestroy(); }
          });
          return;
        }
        actualCall(done).catch(rejectOnce);
      };
      const retry = (delay, reason, done, retained) => requestResource.runInAsyncScope(() => {
        const endRetry = this.#phase(trace, "retry", { retry_reason: reason });
        const resource = new AsyncResource("eris.retry");
        setTimeout(() => {
          try {
            resource.runInAsyncScope(() => {
              endRetry();
              if (settled) return;
              trace.attempts++;
              const resume = () => {
                if (settled) return;
                if (!bucket) run(() => {});
                else {
                  endQueue = this.#phase(trace, "route_queue");
                  if (retained) bucket.retry(() => run(done));
                  else bucket.queue(run, true);
                }
              };
              if (this.globalBlock && auth && !(this.globalRatelimit && shouldSkipQueue)) {
                const endReady = this.#phase(trace, "ready_queue");
                const readyResource = new AsyncResource("eris.readyQueue");
                this.readyQueue.push(() => {
                  try { readyResource.runInAsyncScope(() => { endReady(); resume(); }); }
                  finally { readyResource.emitDestroy(); }
                });
              } else resume();
            });
          } finally { resource.emitDestroy(); }
        }, delay);
      });
      const dispatch = () => {
        if (shouldSkipQueue) {
          run(() => {});
          return;
        }
        endQueue = this.#phase(trace, "route_queue");
        if (!bucket) bucket = this.ratelimits[route] || (this.ratelimits[route] = new SequentialBucket(1, this.latencyRef));
        if (!owned) { bucket.owners++; owned = true; this.#scheduleSweep(); }
        bucket.queue(run, short);
      };
      if (this.globalBlock && auth && !(this.globalRatelimit && shouldSkipQueue)) {
        const endReady = this.#phase(trace, "ready_queue");
        const resource = new AsyncResource("eris.readyQueue");
        this.readyQueue.push(() => {
          try {
            resource.runInAsyncScope(() => {
              endReady();
              dispatch();
            });
          } finally {
            resource.emitDestroy();
          }
        });
      } else {
        dispatch();
      }
    }).finally(() => {
      requestResource.emitDestroy();
      if (!_trace && tracing.hasSubscribers) {
        tracing.publish({ event: "complete", attempts: trace.attempts, omitted: trace.omitted, waits: trace.waits });
      }
    });
  }

  #scheduleSweep() {
    if (this._sweepTimer) return;
    // Planner proposal: one lazy 30s sweep; eligibility is not a TTL.
    this._sweepTimer = setTimeout(() => {
      this._sweepTimer = null;
      const now = Date.now();
      for (const route of Object.keys(this.ratelimits)) {
        const bucket = this.ratelimits[route];
        if (bucket.owners === 0 && !bucket.processing && bucket._queue.length === 0 &&
            Number.isFinite(bucket.reset) && bucket.reset + this.latencyRef.latency < now && this.ratelimits[route] === bucket) {
          delete this.ratelimits[route];
        }
      }
      if (Object.keys(this.ratelimits).length) this.#scheduleSweep();
    }, 30000);
    this._sweepTimer.unref();
  }

  #phase(trace, name, labels = {}) {
    const started = performance.now();
    const phase = { name, labels: { ...labels, attempt: Math.min(trace.attempts, 8) } };
    const detailed = trace.attempts <= 8 && tracing.hasSubscribers;
    if (detailed) tracing.publish({ event: "start", phase });
    else if (trace.attempts > 8) trace.omitted++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      trace.waits[name] = (trace.waits[name] || 0) + performance.now() - started;
      if (detailed) tracing.publish({ event: "end", phase });
    };
  }

  routefy(url, method) {
    let route = url.replace(/\/([a-z-]+)\/(?:[0-9]{17,19})/g, function (match, p) {
      return p === "channels" || p === "guilds" || p === "webhooks" ? match : `/${p}/:id`;
    }).replace(/\/reactions\/[^/]+/g, "/reactions/:id").replace(/\/reactions\/:id\/[^/]+/g, "/reactions/:id/:userID").replace(/^\/webhooks\/(\d+)\/([A-Za-z0-9-_]{64,})/, (match, id, token) => `/webhooks/${id}/${Crypto.createHash("sha256").update(token).digest("hex")}`);
    if (method === "DELETE" && route.endsWith("/messages/:id")) {
      const messageID = url.slice(url.lastIndexOf("/") + 1);
      const createdAt = Base.getCreatedAt(messageID);
      if (Date.now() - this.latencyRef.latency - createdAt >= 1000 * 60 * 60 * 24 * 14) {
        method += "_OLD";
      } else if (Date.now() - this.latencyRef.latency - createdAt <= 1000 * 10) {
        method += "_NEW";
      }
      route = method + route;
    } else if (method === "GET" && /\/guilds\/[0-9]+\/channels$/.test(route)) {
      route = "/guilds/:id/channels";
    }
    if (method === "PUT" || method === "DELETE") {
      const index = route.indexOf("/reactions");
      if (index !== -1) {
        route = "MODIFY" + route.slice(0, index + 10);
      }
    }
    return route;
  }

  shouldSkipQueue(method, url) {
    return method === "POST" && /^\/interactions\/[^/?#]+\/[^/?#]+\/callback$/.test(url.split("?")[0]);
  }

  [util.inspect.custom]() {
    return Base.prototype[util.inspect.custom].call(this);
  }

  toString() {
    return "[RequestHandler]";
  }

  toJSON(props = []) {
    return Base.prototype.toJSON.call(this, [
      "globalBlock",
      "latencyRef",
      "options",
      "ratelimits",
      "readyQueue",
      "userAgent",
      ...props,
    ]);
  }
}

module.exports = RequestHandler;

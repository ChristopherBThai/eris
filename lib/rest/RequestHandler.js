"use strict";

const util = require("util");
const Base = require("../structures/Base");
const DiscordHTTPError = require("../errors/DiscordHTTPError");
const DiscordRESTError = require("../errors/DiscordRESTError");
const Endpoints = require("./Endpoints");
const HTTPS = require("https");
const MultipartData = require("../util/MultipartData");
const SequentialBucket = require("../util/SequentialBucket");
const Zlib = require("zlib");

const MAX_TIMER_DELAY = 2 ** 31 - 1;

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
   * @arg {Object} [file] File object
   * @arg {Buffer} file.file A buffer containing file data
   * @arg {String} file.name What to name the file
   * @arg {Object | String} [requestOptions] Per-request behavior options, or a legacy precomputed ratelimit route
   * @arg {Boolean} [requestOptions.rejectOn429] Whether to reject instead of retrying when rate limited
   * @arg {String} [requestOptions.route] The precomputed ratelimit route
   * @arg {Boolean} [requestOptions.short] Whether to prioritize the request in its ratelimit queue
   * @arg {Boolean} [legacyShort] Whether to prioritize a request using the legacy positional arguments
   * @returns {Promise<Object>} Resolves with the returned JSON data
   */
  request(method, url, auth, body, file, requestOptions, legacyShort) {
    if (typeof requestOptions === "string" || legacyShort !== undefined) {
      requestOptions = { route: requestOptions, short: legacyShort };
    } else {
      requestOptions = requestOptions || {};
    }
    const { rejectOn429, route: requestRoute, short } = requestOptions;
    const route = requestRoute || this.routefy(url, method);

    const _stackHolder = {}; // Preserve async stack
    Error.captureStackTrace(_stackHolder);

    return new Promise((resolve, reject) => {
      let attempts = 0;

      const actualCall = async (cb) => {
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
          reject(err);
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
          reject(err);
          return;
        }

        let reqError;

        req.once("abort", () => {
          cb();
          reqError = reqError || new Error(`Request aborted by client on ${method} ${url}`);
          reqError.req = req;
          reject(reqError);
        }).once("error", (err) => {
          reqError = err;
          req.abort();
        });

        let latency = Date.now();

        req.once("response", (resp) => {
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
            cb();
            reqError = reqError || new Error(`Request aborted by server on ${method} ${url}`);
            reqError.req = req;
            reject(reqError);
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
            reqError = err;
            req.abort();
          }).once("end", () => {
            const now = Date.now();

            if (resp.headers["x-ratelimit-limit"]) {
              this.ratelimits[route].limit = +resp.headers["x-ratelimit-limit"];
            }

            if (method !== "GET" && (resp.headers["x-ratelimit-remaining"] == undefined || resp.headers["x-ratelimit-limit"] == undefined) && this.ratelimits[route].limit !== 1) {
              this._client.emit("debug", `Missing ratelimit headers for SequentialBucket(${this.ratelimits[route].remaining}/${this.ratelimits[route].limit}) with non-default limit\n`
              + `${resp.statusCode} ${resp.headers["content-type"]}: ${method} ${route} | ${resp.headers["cf-ray"]}\n`
              + "x-ratelimit-remaining = " + resp.headers["x-ratelimit-remaining"] + "\n"
              + "x-ratelimit-limit = " + resp.headers["x-ratelimit-limit"] + "\n"
              + "x-ratelimit-reset = " + resp.headers["x-ratelimit-reset"] + "\n"
              + "x-ratelimit-global = " + resp.headers["x-ratelimit-global"]);
            }

            this.ratelimits[route].remaining = resp.headers["x-ratelimit-remaining"] === undefined ? 1 : +resp.headers["x-ratelimit-remaining"] || 0;

            const resetAfter = Number(resp.headers["x-ratelimit-reset-after"]);
            const retryAfterHeader = Number(resp.headers["retry-after"]);
            const hasResetAfter = resp.headers["x-ratelimit-reset-after"] !== undefined && resp.headers["x-ratelimit-reset-after"] !== "" && Number.isFinite(resetAfter) && resetAfter >= 0;
            const hasRetryAfterHeader = resp.headers["retry-after"] !== undefined && resp.headers["retry-after"] !== "" && Number.isFinite(retryAfterHeader) && retryAfterHeader >= 0;
            let retryAfter = hasResetAfter ? resetAfter : hasRetryAfterHeader ? retryAfterHeader : NaN;
            let parsed429Response;
            if (resp.statusCode === 429) {
              if (response.length > 0) {
                try {
                  parsed429Response = JSON.parse(response);
                } catch {
                  // Malformed 429 bodies are handled as HTTP errors when rejection is requested
                }
              }

              const bodyRetryAfterValue = parsed429Response && typeof parsed429Response === "object" ? parsed429Response.retry_after : undefined;
              const hasBodyRetryAfter = typeof bodyRetryAfterValue === "number" && Number.isFinite(bodyRetryAfterValue) && bodyRetryAfterValue >= 0;
              if (hasBodyRetryAfter && (resp.headers["x-ratelimit-scope"] === "shared" || (!hasResetAfter && !hasRetryAfterHeader))) {
                retryAfter = bodyRetryAfterValue;
              } else if (!hasResetAfter && !hasRetryAfterHeader) {
                retryAfter = 0;
              }
            }
            retryAfter = Math.min(retryAfter * 1000, MAX_TIMER_DELAY);
            if (retryAfter >= 0) {
              const ratelimitDelay = resp.statusCode === 429 ? retryAfter : retryAfter || 1;
              if (resp.headers["x-ratelimit-global"]) {
                this.globalBlock = true;
                this.globalRatelimit = true;
                setTimeout(() => this.globalUnblock(), ratelimitDelay);
              } else {
                this.ratelimits[route].reset = ratelimitDelay + now;
              }
            } else if (resp.headers["x-ratelimit-reset"]) {
              let resetTime = +resp.headers["x-ratelimit-reset"] * 1000;
              if (route.endsWith("/reactions/:id") && (+resp.headers["x-ratelimit-reset"] * 1000 - headerNow) === 1000) {
                resetTime = now + 250;
              }
              this.ratelimits[route].reset = Math.max(resetTime - this.latencyRef.latency, now);
            } else {
              this.ratelimits[route].reset = now;
            }

            if (resp.statusCode !== 429) {
              const content = typeof body === "object" ? `${body.content} ` : "";
              this._client.emit("debug", `${content}${now} ${route} ${resp.statusCode}: ${latency}ms (${this.latencyRef.latency}ms avg) | ${this.ratelimits[route].remaining}/${this.ratelimits[route].limit} left | Reset ${this.ratelimits[route].reset} (${this.ratelimits[route].reset - now}ms left)`);
            }

            if (resp.statusCode >= 300) {
              if (resp.statusCode === 429) {
                const content = typeof body === "object" ? `${body.content} ` : "";
                this._client.emit("debug", `${resp.headers["x-ratelimit-global"] ? "Global" : "Unexpected"} 429 (╯°□°）╯︵ ┻━┻: ${response}\n${content} ${now} ${route} ${resp.statusCode}: ${latency}ms (${this.latencyRef.latency}ms avg) | ${this.ratelimits[route].remaining}/${this.ratelimits[route].limit} left | Reset ${retryAfter} (${this.ratelimits[route].reset - now}ms left) | Scope ${resp.headers["x-ratelimit-scope"]}`);
                if (!rejectOn429) {
                  if (retryAfter) {
                    setTimeout(() => {
                      cb();
                      this.request(method, url, auth, body, file, { route: route, short: true, rejectOn429: rejectOn429 }).then(resolve).catch(reject);
                    }, retryAfter);
                  } else {
                    cb();
                    this.request(method, url, auth, body, file, { route: route, short: true, rejectOn429: rejectOn429 }).then(resolve).catch(reject);
                  }
                  return;
                }
              } else if (resp.statusCode === 502 && ++attempts < 4) {
                this._client.emit("debug", "A wild 502 appeared! Thanks CloudFlare!");
                setTimeout(() => {
                  this.request(method, url, auth, body, file, { route: route, short: true, rejectOn429: rejectOn429 }).then(resolve).catch(reject);
                }, Math.floor(Math.random() * 1900 + 100));
                return cb();
              }
              cb();

              if (resp.statusCode === 429 && parsed429Response !== undefined) {
                response = parsed429Response;
              } else if (resp.statusCode !== 429 && response.length > 0) {
                if (resp.headers["content-type"] === "application/json") {
                  try {
                    response = JSON.parse(response);
                  } catch (err) {
                    reject(err);
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
              if (resp.statusCode === 429) {
                err.retryAfter = retryAfter;
              }
              reject(err);
              return;
            }

            if (response.length > 0) {
              if (resp.headers["content-type"] === "application/json") {
                try {
                  response = JSON.parse(response);
                } catch (err) {
                  cb();
                  reject(err);
                  return;
                }
              }
            }

            cb();
            resolve(response || undefined);
          });
        });

        req.setTimeout(this.options.requestTimeout, () => {
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

      const shouldSkipQueue = this.shouldSkipQueue(route);
      if (this.globalBlock && auth) {
        if (this.globalRatelimit && shouldSkipQueue) {
          if (!this.ratelimits[route]) {
            this.ratelimits[route] = new SequentialBucket(1, this.latencyRef, shouldSkipQueue);
          }
          this.ratelimits[route].queue(actualCall, short);
        }
        this.readyQueue.push(() => {
          if (!this.ratelimits[route]) {
            this.ratelimits[route] = new SequentialBucket(1, this.latencyRef, shouldSkipQueue);
          }
          this.ratelimits[route].queue(actualCall, short);
        });
      } else {
        if (!this.ratelimits[route]) {
          this.ratelimits[route] = new SequentialBucket(1, this.latencyRef, shouldSkipQueue);
        }
        this.ratelimits[route].queue(actualCall, short);
      }
    });
  }

  routefy(url, method) {
    let route = url.replace(/\/([a-z-]+)\/(?:[0-9]{17,19})/g, function (match, p) {
      return p === "channels" || p === "guilds" || p === "webhooks" ? match : `/${p}/:id`;
    }).replace(/\/reactions\/[^/]+/g, "/reactions/:id").replace(/\/reactions\/:id\/[^/]+/g, "/reactions/:id/:userID").replace(/^\/webhooks\/(\d+)\/[A-Za-z0-9-_]{64,}/, "/webhooks/$1/:token");
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

  shouldSkipQueue(route) {
    return route?.includes("/interactions");
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

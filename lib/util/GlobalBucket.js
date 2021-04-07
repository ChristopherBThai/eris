const logger = require('../../../../src/utils/logger.js');
const redis = require('redis').createClient();

class GlobalBucket {
		constructor() {
        this.processing = false;
        this._queue = [];
				this.blockTimer = false;
    }

    queue(func) {
				this._queue.push(func);
				this.check();
    }

    async check(override) {

				if (!this.checkProcessing(override)) return;
				
				if(this.blockTimer) {
						await this.blockTimer;
						clearTimeout(this.blockTimer);
						this.blockTimer = false;
						this.check(override);
						return;
				}

				if (!(await this.checkLimit())) {
						logger.increment("redisGlobalRateLimitAvoid");
						await this.fetchGlobalTimer();
						this.check(override);
						return;
				}

				if (!this.checkProcessing(override)) return;

				this.processing = true;
				this._queue.shift()(() => {
						if(this._queue.length > 0) {
								this.check(true);
						} else {
								this.processing = false;
						}
				});
    }

	checkProcessing (override) {
		if(this._queue.length === 0) {
            if(this.processing) {
                clearTimeout(this.processing);
                this.processing = false;
            }
            return;
        }
        if(this.processing && !override) {
            return;
        }
		return true;
	}

	block(time) {
		logger.increment("globlRateLimitAvoid");
		this.blockTimer = new Promise((res,rej) => {
			setTimeout(res,time);
		});
	}

	checkLimit() {
		return new Promise((res,rej) => {
			redis.decr("ratelimit",(err,reply) => {
				if(err)
					rej(err);
				else{
					if( reply >= 0 ) 
						res(true);
					else 
						res(false);
				}
			});
		});
	}

	fetchGlobalTimer() {
		return new Promise((res,rej) => {
			redis.get("ratelimitTimer",(err,reply) => {
				if(err)
					rej(err);
				else{
					let timer = 0
					if (reply)
						timer = new Date(+reply) - Date.now();
					if (!timer || timer <= 0) {
						timer = 5000;
						logger.increment("invalidRatelimitDate");
					}
					this.block(timer);
					res(reply);
				}
			});
		});
	}
}

module.exports = GlobalBucket;

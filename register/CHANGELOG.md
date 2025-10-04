## [1.0.1](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.0.0...v1.0.1) (2025-10-04)


### Bug Fixes

* testing ci/cd ([a648cd3](https://github.com/adobe/helix-snapshot-scheduler/commit/a648cd333e5792138a26c7c383b613c4ffd83c29))

# 1.0.0 (2025-10-04)


### Bug Fixes

* add cors headers in responses ([ffcb32c](https://github.com/adobe/helix-snapshot-scheduler/commit/ffcb32ce5156ae36487b256de4385dd6a995c140))
* add minimum 5 minute check in the future ([b2d976a](https://github.com/adobe/helix-snapshot-scheduler/commit/b2d976aa54032a902eebadd53bb32b9424891cab))
* adding debug logging ([61ef423](https://github.com/adobe/helix-snapshot-scheduler/commit/61ef42308c3869f2d9e5684ae8bd3d9a0dd278d7))
* bug fix for allow-origin ([8e8541e](https://github.com/adobe/helix-snapshot-scheduler/commit/8e8541e3825a16122f0f277dba1ede89782fa4f0))
* bug fix in isAuthorized ([2030b62](https://github.com/adobe/helix-snapshot-scheduler/commit/2030b6294763d068595ca2f95b2d74d2ee08998e))
* cleanup and limit origins ([d8d51ae](https://github.com/adobe/helix-snapshot-scheduler/commit/d8d51ae92697354ea373a4bcf861d0851807f825))
* delaySeconds should never be negative ([786bab7](https://github.com/adobe/helix-snapshot-scheduler/commit/786bab77fdad39a7669ce5a8ea8242e373a98763))
* edge case and cleanup ([034fae2](https://github.com/adobe/helix-snapshot-scheduler/commit/034fae275411a5bc4c0a0056245dbc691d236f44))
* full origin for localhost for testing only ([f513ef2](https://github.com/adobe/helix-snapshot-scheduler/commit/f513ef2d8e728562eb90807bedf8ef69bb5cc16c))
* get scheduledPublish from the right object. update error handling ([60fe3da](https://github.com/adobe/helix-snapshot-scheduler/commit/60fe3dadf5e20564c7b002c20b58fbdfbbb85a04))
* handling options requests ([82dcd84](https://github.com/adobe/helix-snapshot-scheduler/commit/82dcd842b402e1d01fc25f6ac09906b3ed052ad3))
* lint fixes ([025efc8](https://github.com/adobe/helix-snapshot-scheduler/commit/025efc8e27fb062a6c0201c6afccefa34ab31d4c))
* remove auth check while scheduling temporarily. registering still requires it ([0f0f5b4](https://github.com/adobe/helix-snapshot-scheduler/commit/0f0f5b45ff1ef67678f5111809310c5fedb15d15))
* send right auth token format ([9d8c6aa](https://github.com/adobe/helix-snapshot-scheduler/commit/9d8c6aa2f4d6f1a9d4965e0d7388b0e41dc2c2e9))
* urls in package.json ([8f6256d](https://github.com/adobe/helix-snapshot-scheduler/commit/8f6256d511335921d55f1f6d6cfb13993d9a8dbc))


### Features

* add consumer and producer workers for the 2 queues ([a0794cb](https://github.com/adobe/helix-snapshot-scheduler/commit/a0794cb948df5f816a1a472bba6d406a4d3d01f4))
* add register and schedule api endpoints ([59aabf5](https://github.com/adobe/helix-snapshot-scheduler/commit/59aabf5b0cf2e5457d73569e5d5d770a55ff0e55))
* add register worker and update R2 bucket ([9721bad](https://github.com/adobe/helix-snapshot-scheduler/commit/9721bad80eb367ca993e9d6e856eb03dc9e5c66d))
* add retry and dlq for publish queue ([c1617aa](https://github.com/adobe/helix-snapshot-scheduler/commit/c1617aa6976eef5acae7b6bb97da46f5603e347b))
* batch cleanup after publish to reduce chatter ([f8467bc](https://github.com/adobe/helix-snapshot-scheduler/commit/f8467bc8acd1848865749ba3a0f998a87ded6930))
* move registered org/site to KV with apiTokens ([52905c2](https://github.com/adobe/helix-snapshot-scheduler/commit/52905c21c2e7c95b3f6503ca162ee52544b3988f))

# [1.4.0](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.3.0...v1.4.0) (2026-03-11)


### Features

* store userId if passed in while updating schedule ([b2bedc5](https://github.com/adobe/helix-snapshot-scheduler/commit/b2bedc5838758535bfb4d4c4fe1d9fbb1fba8ad5))
* store userId if passed in while updating schedule ([d88726d](https://github.com/adobe/helix-snapshot-scheduler/commit/d88726de1aff906aa5d6a86b688c33c306aed335))

# [1.3.0](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.2.0...v1.3.0) (2026-03-09)


### Bug Fixes

* allow calls to get schedule ([6163b16](https://github.com/adobe/helix-snapshot-scheduler/commit/6163b162d43796ccc02adf95b3189cbf07e9ed96))
* cleanup response formatting ([b0df1cc](https://github.com/adobe/helix-snapshot-scheduler/commit/b0df1cca50959881d04912dd3dd9e825a6c17d7a))


### Features

* get schedule for a single path ([667f5df](https://github.com/adobe/helix-snapshot-scheduler/commit/667f5dfe7235368b1625f36f367deb878a198818))

# [1.2.0](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.1.4...v1.2.0) (2026-03-09)


### Bug Fixes

* add publish permissions check ([b778088](https://github.com/adobe/helix-snapshot-scheduler/commit/b7780886cc06077bc2732a7a34246ac3c97757ac))
* audit log ([f0d6e52](https://github.com/adobe/helix-snapshot-scheduler/commit/f0d6e52d1098e3c42f4a0286f334fd15240d3bce))
* use user auth token to make log call ([6887a07](https://github.com/adobe/helix-snapshot-scheduler/commit/6887a0760d96f74105fe713ba20ecbf30764333d))


### Features

* handle single page scheduling ([087a241](https://github.com/adobe/helix-snapshot-scheduler/commit/087a241f2ea8f58f41de7903bc63b29256afca3b))

## [1.1.4](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.1.3...v1.1.4) (2025-12-18)


### Bug Fixes

* allow localhost testing for tools ([9ac4073](https://github.com/adobe/helix-snapshot-scheduler/commit/9ac4073e02274339137aae373d5512c8c4b10e46))

## [1.1.3](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.1.2...v1.1.3) (2025-11-25)


### Bug Fixes

* add post body for approve call ([f6d7c10](https://github.com/adobe/helix-snapshot-scheduler/commit/f6d7c10d173e6537eb556bb8a678641716846eed))

## [1.1.2](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.1.1...v1.1.2) (2025-11-25)


### Bug Fixes

* error handling issue ([4ba6f3b](https://github.com/adobe/helix-snapshot-scheduler/commit/4ba6f3bd127a02c12593690234b637dc40a3f180))

## [1.1.1](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.1.0...v1.1.1) (2025-11-25)


### Bug Fixes

* putting the content-type header back for now ([0d3d58d](https://github.com/adobe/helix-snapshot-scheduler/commit/0d3d58dbcae57d9dd11de84c0fc5fb1dadb9af2e))
* review approve endpoint ([f6d4ab3](https://github.com/adobe/helix-snapshot-scheduler/commit/f6d4ab36253df499d5d57441213bf40778eac4f0))

# [1.1.0](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.0.8...v1.1.0) (2025-11-25)


### Features

* add review approve option ([3497cc3](https://github.com/adobe/helix-snapshot-scheduler/commit/3497cc37504956dd48adf34b2456bc253802593d))

## [1.0.8](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.0.7...v1.0.8) (2025-11-25)


### Bug Fixes

* add additional Auth header while fetching snapshot manifest ([8299f19](https://github.com/adobe/helix-snapshot-scheduler/commit/8299f19eecb5ad1b771162f5ee405832593ebb14))

## [1.0.7](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.0.6...v1.0.7) (2025-11-25)


### Bug Fixes

* dlq cleanup ([4944c29](https://github.com/adobe/helix-snapshot-scheduler/commit/4944c29c434177a98278321ec886034e26736f72))
* lint issue ([c95458c](https://github.com/adobe/helix-snapshot-scheduler/commit/c95458c10210437729623f09bac4999b1682b65a))
* update package-lock file ([7ceaf1d](https://github.com/adobe/helix-snapshot-scheduler/commit/7ceaf1d7f1cb88629db9d4e8ea85bbc8c009ebe7))
* updating all package lock files ([d8cff34](https://github.com/adobe/helix-snapshot-scheduler/commit/d8cff34411368fe62b77ccdc559baaac71d88a23))
* upgrade to node 24 ([9eb4d38](https://github.com/adobe/helix-snapshot-scheduler/commit/9eb4d3888efd49193ff229287553b182aec40a3c))

## [1.0.6](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.0.5...v1.0.6) (2025-10-15)


### Bug Fixes

* debugging ([f3717d6](https://github.com/adobe/helix-snapshot-scheduler/commit/f3717d68601084268753ef5bb4353b19b57108bc))
* debugging ([c647abb](https://github.com/adobe/helix-snapshot-scheduler/commit/c647abb9cf1ad22a2c319ca0d5862f758db22412))
* debugging more ([f0aa195](https://github.com/adobe/helix-snapshot-scheduler/commit/f0aa195f1530341cd9ed7ee63851413623e8eac1))
* more debugs ([d1bd1f2](https://github.com/adobe/helix-snapshot-scheduler/commit/d1bd1f25b352b2bb20e8dd7961548c1780d4bb00))
* tweaks to get final publish call working ([789913e](https://github.com/adobe/helix-snapshot-scheduler/commit/789913e4819ee635206143daacbc9c00d01f544d))

## [1.0.5](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.0.4...v1.0.5) (2025-10-14)


### Bug Fixes

* allowing for da-nx testing ([684e71e](https://github.com/adobe/helix-snapshot-scheduler/commit/684e71ed702186a6b6d3ebe1e9294207fa7c000b))
* switch apiToken to apiKey to be consistent ([27cdb0b](https://github.com/adobe/helix-snapshot-scheduler/commit/27cdb0bd99eb83d4c69e5e2b87ec725c19a6d9a0))
* updating publish to use apiKey instead of apiToken ([c18aee5](https://github.com/adobe/helix-snapshot-scheduler/commit/c18aee510f1c13d8f3f65f0162cb502f4881f82b))

## [1.0.4](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.0.3...v1.0.4) (2025-10-08)


### Bug Fixes

* allow additional headers in cors ([fe3a099](https://github.com/adobe/helix-snapshot-scheduler/commit/fe3a0998aca0aad6c727b8656fbe134a46377821))
* cors issue for register requests from browser ([47da3f0](https://github.com/adobe/helix-snapshot-scheduler/commit/47da3f0cfa451f0eba90e5adf7a3ef24f42b7d04))

## [1.0.3](https://github.com/adobe/helix-snapshot-scheduler/compare/v1.0.2...v1.0.3) (2025-10-04)


### Bug Fixes

* add package-lock.json to fix semantic release issue ([5811dac](https://github.com/adobe/helix-snapshot-scheduler/commit/5811dacaedc292d92a296eb8d926d8d3dd2fdc1a))
* single semantic release deploying all workers ([dc76c42](https://github.com/adobe/helix-snapshot-scheduler/commit/dc76c423a365bf161f94841566873d67933626e7))
* switched to one semantic release to deploy all workers ([bb3fb63](https://github.com/adobe/helix-snapshot-scheduler/commit/bb3fb63f5a3df5cb9e6f847bb02d13720dd146cc))
* testing semantic release ([493d2ac](https://github.com/adobe/helix-snapshot-scheduler/commit/493d2acfcc322f0e1a5f11899875283b0a247043))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

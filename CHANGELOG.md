# Changelog

## [0.5.2](https://github.com/rajohan/Mira-Dashboard/compare/v0.5.1...v0.5.2) (2026-08-28)


### Bug Fixes

* **delivery:** make provisioning generation-independent ([#502](https://github.com/rajohan/Mira-Dashboard/issues/502)) ([c6edd12](https://github.com/rajohan/Mira-Dashboard/commit/c6edd1217f79b310f0d8ae58e1868d6888d4b9f3))

## [0.5.1](https://github.com/rajohan/Mira-Dashboard/compare/v0.5.0...v0.5.1) (2026-08-28)


### Bug Fixes

* **operations:** preserve progress and repair log access ([#500](https://github.com/rajohan/Mira-Dashboard/issues/500)) ([46f97b1](https://github.com/rajohan/Mira-Dashboard/commit/46f97b145a8b8bea02b3820c27d66923d9ac6ef2))

## [0.5.0](https://github.com/rajohan/Mira-Dashboard/compare/v0.4.4...v0.5.0) (2026-08-28)


### Features

* **operations:** improve durable runtime feedback ([#497](https://github.com/rajohan/Mira-Dashboard/issues/497)) ([01d22ce](https://github.com/rajohan/Mira-Dashboard/commit/01d22ce03e7cc44151055e332e637e63decdd818))

## [0.4.4](https://github.com/rajohan/Mira-Dashboard/compare/v0.4.3...v0.4.4) (2026-08-28)


### Bug Fixes

* **docker:** settle updates against stable authority ([#495](https://github.com/rajohan/Mira-Dashboard/issues/495)) ([67c701b](https://github.com/rajohan/Mira-Dashboard/commit/67c701bc2f8e2900a456a0673d318c18f42fa759))

## [0.4.3](https://github.com/rajohan/Mira-Dashboard/compare/v0.4.2...v0.4.3) (2026-08-27)


### Bug Fixes

* **docker:** honor manual updater intent ([#490](https://github.com/rajohan/Mira-Dashboard/issues/490)) ([2240d47](https://github.com/rajohan/Mira-Dashboard/commit/2240d479bd35cb2c48bfdbe33ebc0dccb50329dd))
* **docker:** retain updater verification stage ([#491](https://github.com/rajohan/Mira-Dashboard/issues/491)) ([8a4be06](https://github.com/rajohan/Mira-Dashboard/commit/8a4be067b89b1e343eb2a7caef20f90f827adb7f))
* **logs:** expose timestamped dashboard streams ([#492](https://github.com/rajohan/Mira-Dashboard/issues/492)) ([4242d8f](https://github.com/rajohan/Mira-Dashboard/commit/4242d8f6970a971aa738aad7dc2371d03795c110))

## [0.4.2](https://github.com/rajohan/Mira-Dashboard/compare/v0.4.1...v0.4.2) (2026-08-27)


### Bug Fixes

* **delivery:** preserve migration id compatibility ([#488](https://github.com/rajohan/Mira-Dashboard/issues/488)) ([867529c](https://github.com/rajohan/Mira-Dashboard/commit/867529c5f8beb24496baea34dc7633ffdf2f5547))

## [0.4.1](https://github.com/rajohan/Mira-Dashboard/compare/v0.4.0...v0.4.1) (2026-08-27)


### Bug Fixes

* **jobs:** expand worker action inventory budget ([#486](https://github.com/rajohan/Mira-Dashboard/issues/486)) ([dd85928](https://github.com/rajohan/Mira-Dashboard/commit/dd859288ef27793eacf9f83b7a6deca1e36bbe7f))

## [0.4.0](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.9...v0.4.0) (2026-08-27)


### Features

* **operations:** track queued jobs globally ([#481](https://github.com/rajohan/Mira-Dashboard/issues/481)) ([47342c6](https://github.com/rajohan/Mira-Dashboard/commit/47342c60af87555bff22ed8f1e3b1ede652f8791))


### Bug Fixes

* **auth:** eliminate WebAuthn prompt delay ([#480](https://github.com/rajohan/Mira-Dashboard/issues/480)) ([66e19c9](https://github.com/rajohan/Mira-Dashboard/commit/66e19c9258d24bb54a0891adb1beda3f85e234f9))
* **browser:** restore application icons ([#482](https://github.com/rajohan/Mira-Dashboard/issues/482)) ([e478d08](https://github.com/rajohan/Mira-Dashboard/commit/e478d08feec45523d26274dcce2297dbfb1bfe96))
* **delivery:** restore native stack merge ([#484](https://github.com/rajohan/Mira-Dashboard/issues/484)) ([77e4a42](https://github.com/rajohan/Mira-Dashboard/commit/77e4a42df05762ee94e09e3246bd706a0ad4d683))
* **git:** sync allowlisted workspace additions ([#477](https://github.com/rajohan/Mira-Dashboard/issues/477)) ([a8ee79b](https://github.com/rajohan/Mira-Dashboard/commit/a8ee79bcd979ebd8c15984fa2f768069357fd3c7))
* **jobs:** associate manual runs with schedules ([#478](https://github.com/rajohan/Mira-Dashboard/issues/478)) ([6ce4b6e](https://github.com/rajohan/Mira-Dashboard/commit/6ce4b6ed5a81c41c380f7def20aeb0466d414131))
* **openclaw:** surface available updates ([#479](https://github.com/rajohan/Mira-Dashboard/issues/479)) ([7295aea](https://github.com/rajohan/Mira-Dashboard/commit/7295aea19da7950f4d59c6e914b0191411eef2aa))

## [0.3.9](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.8...v0.3.9) (2026-08-27)


### Bug Fixes

* **bootstrap:** migrate managed log archives ([#472](https://github.com/rajohan/Mira-Dashboard/issues/472)) ([02100b1](https://github.com/rajohan/Mira-Dashboard/commit/02100b117ddc5c85ae893686e2ffc6144c924bf2))
* **docker:** reconcile full stack after updates ([#473](https://github.com/rajohan/Mira-Dashboard/issues/473)) ([3955e6c](https://github.com/rajohan/Mira-Dashboard/commit/3955e6caea75be9c8d2e057694bb70b7e6ebb7c5))
* **logs:** respect Prowlarr native rotation ([#476](https://github.com/rajohan/Mira-Dashboard/issues/476)) ([5582b04](https://github.com/rajohan/Mira-Dashboard/commit/5582b04b7ae492fc3d9d6ec9535f73098fdf4496))
* **monitoring:** aggregate run notifications ([#474](https://github.com/rajohan/Mira-Dashboard/issues/474)) ([9afe7b6](https://github.com/rajohan/Mira-Dashboard/commit/9afe7b698f5f5fd971c37b17c15eb3f494dcdbdb))

## [0.3.8](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.7...v0.3.8) (2026-08-26)


### Bug Fixes

* **delivery:** repair host provisioning and log drift ([#470](https://github.com/rajohan/Mira-Dashboard/issues/470)) ([dd5c192](https://github.com/rajohan/Mira-Dashboard/commit/dd5c192d0b1afbb9a452c5fcc41c05b15b95ab5d))

## [0.3.7](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.6...v0.3.7) (2026-08-26)


### Bug Fixes

* **database:** make maintenance review actionable ([#468](https://github.com/rajohan/Mira-Dashboard/issues/468)) ([e8385bc](https://github.com/rajohan/Mira-Dashboard/commit/e8385bcb09958907d4906b0330e69f404b502dff))

## [0.3.6](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.5...v0.3.6) (2026-08-26)


### Bug Fixes

* **operations:** restore production dashboard sources ([#466](https://github.com/rajohan/Mira-Dashboard/issues/466)) ([d54bc0b](https://github.com/rajohan/Mira-Dashboard/commit/d54bc0b97c593ab60e9f1982027cb2ac732180c5))

## [0.3.5](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.4...v0.3.5) (2026-08-25)


### Bug Fixes

* **delivery:** bound provisioning unit name ([#463](https://github.com/rajohan/Mira-Dashboard/issues/463)) ([861a1e3](https://github.com/rajohan/Mira-Dashboard/commit/861a1e386439f9e90ac44acc9158982e41051fe6))

## [0.3.4](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.3...v0.3.4) (2026-08-25)


### Bug Fixes

* **observability:** restore host diagnostics after bootstrap ([#461](https://github.com/rajohan/Mira-Dashboard/issues/461)) ([d21cf84](https://github.com/rajohan/Mira-Dashboard/commit/d21cf84bb91712d7ce87bca877d2af79f3be9da5))

## [0.3.3](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.2...v0.3.3) (2026-08-25)


### Bug Fixes

* **bootstrap:** provision generic managed log access ([#459](https://github.com/rajohan/Mira-Dashboard/issues/459)) ([79afcc3](https://github.com/rajohan/Mira-Dashboard/commit/79afcc34d4832472bca147d7741b621594ab129d))

## [0.3.2](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.1...v0.3.2) (2026-08-25)


### Bug Fixes

* **bootstrap:** secure Submaker log boundary ([#457](https://github.com/rajohan/Mira-Dashboard/issues/457)) ([17fc7b1](https://github.com/rajohan/Mira-Dashboard/commit/17fc7b1dd9064b735d7ce22d34dfa53b54b50224))

## [0.3.1](https://github.com/rajohan/Mira-Dashboard/compare/v0.3.0...v0.3.1) (2026-08-25)


### Bug Fixes

* **bootstrap:** retain release assets through provisioning ([#455](https://github.com/rajohan/Mira-Dashboard/issues/455)) ([f6954f0](https://github.com/rajohan/Mira-Dashboard/commit/f6954f00b7bb1ed533bacdaa996bd43369b3ce98))

## [0.3.0](https://github.com/rajohan/Mira-Dashboard/compare/v0.2.4...v0.3.0) (2026-08-25)


### Features

* **delivery:** deploy published releases ([#453](https://github.com/rajohan/Mira-Dashboard/issues/453)) ([762f904](https://github.com/rajohan/Mira-Dashboard/commit/762f904b702039ece676f3574ddf07cfa7ea74b5))
* **jobs:** expose dashboard schedule controls ([#451](https://github.com/rajohan/Mira-Dashboard/issues/451)) ([87f3e87](https://github.com/rajohan/Mira-Dashboard/commit/87f3e876d62e52cb3b8584b733da4c739123292c))


### Bug Fixes

* **bootstrap:** provision managed log access ([#452](https://github.com/rajohan/Mira-Dashboard/issues/452)) ([604d571](https://github.com/rajohan/Mira-Dashboard/commit/604d57115d1ee7e4dd23a58a328913d0b7ceed63))

## [0.2.4](https://github.com/rajohan/Mira-Dashboard/compare/v0.2.3...v0.2.4) (2026-08-24)


### Bug Fixes

* **bootstrap:** admit systemd inaccessible mounts ([7ded122](https://github.com/rajohan/Mira-Dashboard/commit/7ded122574d2aad6acd3827bb64ae66e7d609c7e))

## [0.2.3](https://github.com/rajohan/Mira-Dashboard/compare/v0.2.2...v0.2.3) (2026-08-24)


### Bug Fixes

* **bootstrap:** map web runtime identities correctly ([2459dc9](https://github.com/rajohan/Mira-Dashboard/commit/2459dc981aae8203abe3433c42dc2d8738d0f43f))

## [0.2.2](https://github.com/rajohan/Mira-Dashboard/compare/v0.2.1...v0.2.2) (2026-08-24)


### Bug Fixes

* **bootstrap:** admit root-owned Bun runtime ([#444](https://github.com/rajohan/Mira-Dashboard/issues/444)) ([2b85c9a](https://github.com/rajohan/Mira-Dashboard/commit/2b85c9a78259b226f40d8d77e64addecff22ecce))

## [0.2.1](https://github.com/rajohan/Mira-Dashboard/compare/v0.2.0...v0.2.1) (2026-08-24)


### Bug Fixes

* **bootstrap:** complete clean-host configuration ([97e882f](https://github.com/rajohan/Mira-Dashboard/commit/97e882ffe3bacfceec76cac6e64b8e5f9c78863c))

## [0.2.0](https://github.com/rajohan/Mira-Dashboard/compare/v0.1.0...v0.2.0) (2026-08-24)


### Features

* add atomic release operations and trusted PR dev ([#335](https://github.com/rajohan/Mira-Dashboard/issues/335)) ([8757ce4](https://github.com/rajohan/Mira-Dashboard/commit/8757ce4c2f5e2cbd786bf45c299298c29f90c1c7))
* add dashboard PR approval workflow ([#4](https://github.com/rajohan/Mira-Dashboard/issues/4)) ([4661f6c](https://github.com/rajohan/Mira-Dashboard/commit/4661f6ce4845eca77af430d1d872def2e9dbc56c))
* add shared API contracts and observability ([#346](https://github.com/rajohan/Mira-Dashboard/issues/346)) ([bb4fcac](https://github.com/rajohan/Mira-Dashboard/commit/bb4fcac35847ed2ffcf0711936a3f3cc9937000c))
* add SQLite lifecycle management ([#318](https://github.com/rajohan/Mira-Dashboard/issues/318)) ([e0d1223](https://github.com/rajohan/Mira-Dashboard/commit/e0d12232b8ffba133f17bbfeca9539a8063ecf0b))
* **chat:** add canonical turn shadow projection ([#356](https://github.com/rajohan/Mira-Dashboard/issues/356)) ([dbe7033](https://github.com/rajohan/Mira-Dashboard/commit/dbe703386be80fc9a522dd81a19fdfd515d54080))
* **chat:** add ElevenLabs voice input ([41d447a](https://github.com/rajohan/Mira-Dashboard/commit/41d447a5f9ca82c197c00701e63ed84ecf14d3b4))
* **chat:** add emoji picker ([5616755](https://github.com/rajohan/Mira-Dashboard/commit/561675516d1ce93813b46e13d20812bb99bebd14))
* **chat:** add runtime parity observability ([#359](https://github.com/rajohan/Mira-Dashboard/issues/359)) ([28bc9b2](https://github.com/rajohan/Mira-Dashboard/commit/28bc9b2355de5a86f8590d7d974526d927f13cb4))
* **chat:** add TTS playback and message deletion ([acb4e25](https://github.com/rajohan/Mira-Dashboard/commit/acb4e25ba1218f1872cefec7e4b2f0502bb717dd))
* **chat:** split session selector by agent ([#52](https://github.com/rajohan/Mira-Dashboard/issues/52)) ([bbca9c2](https://github.com/rajohan/Mira-Dashboard/commit/bbca9c2fab5741069f0da66eef08657bb77832d1))
* **chat:** toggle thinking and tool output ([1cfc6f9](https://github.com/rajohan/Mira-Dashboard/commit/1cfc6f9142f4058580bddf629a90c1b5dc795b2b))
* **chat:** version replay snapshots and add provider fixtures ([#352](https://github.com/rajohan/Mira-Dashboard/issues/352)) ([d17b636](https://github.com/rajohan/Mira-Dashboard/commit/d17b636fc9dc6170b3a845d55b87deccfe544b94))
* **dashboard:** flag repos checked out off main ([#51](https://github.com/rajohan/Mira-Dashboard/issues/51)) ([346d936](https://github.com/rajohan/Mira-Dashboard/commit/346d9363351e66d554273beaae65a32354f5d882))
* **delivery:** automate greenfield production bootstrap ([d809038](https://github.com/rajohan/Mira-Dashboard/commit/d8090385a2cb4c77cd4b48e5c9c868fc8298b6c4))
* **development:** add source-watched Bun stack ([#417](https://github.com/rajohan/Mira-Dashboard/issues/417)) ([bf8b788](https://github.com/rajohan/Mira-Dashboard/commit/bf8b788e4097ac58d24beb328d1f8022563e5009))
* expand Delivery and managed PR dev ([#341](https://github.com/rajohan/Mira-Dashboard/issues/341)) ([c93be72](https://github.com/rajohan/Mira-Dashboard/commit/c93be720023b9e9d2b34966523d2b0e14e9d0134))
* **greenfield:** add persistent Gateway operations ([#409](https://github.com/rajohan/Mira-Dashboard/issues/409)) ([08456df](https://github.com/rajohan/Mira-Dashboard/commit/08456df62ddbc173c368693a17c4dc8456800f72))
* **greenfield:** add reports overview ([#407](https://github.com/rajohan/Mira-Dashboard/issues/407)) ([591e7cb](https://github.com/rajohan/Mira-Dashboard/commit/591e7cb362b9c36b9f4e5b42ec4e77d1b40a65a0))
* **greenfield:** add Storybook and refresh test tooling ([#405](https://github.com/rajohan/Mira-Dashboard/issues/405)) ([9c56830](https://github.com/rajohan/Mira-Dashboard/commit/9c56830c059e6facbc9c52456cf940e480e9adc4))
* **greenfield:** add system metrics overview ([#406](https://github.com/rajohan/Mira-Dashboard/issues/406)) ([8cdf482](https://github.com/rajohan/Mira-Dashboard/commit/8cdf482829fd6d4f85f9dea72c2470005a642bb3))
* **greenfield:** add workspace operations ([#411](https://github.com/rajohan/Mira-Dashboard/issues/411)) ([10655fb](https://github.com/rajohan/Mira-Dashboard/commit/10655fb16dc140f4d1fecb7d2ab62a5915e14c57))
* **greenfield:** close database observability parity ([#423](https://github.com/rajohan/Mira-Dashboard/issues/423)) ([26dd606](https://github.com/rajohan/Mira-Dashboard/commit/26dd60627efb267530721110e8e1321cfdc531c3))
* **greenfield:** close Delivery parity ([#425](https://github.com/rajohan/Mira-Dashboard/issues/425)) ([d544711](https://github.com/rajohan/Mira-Dashboard/commit/d544711f559b6a70d82c9e40e14b4d34449f506e))
* **greenfield:** close Docker operations parity ([#424](https://github.com/rajohan/Mira-Dashboard/issues/424)) ([7cdbd79](https://github.com/rajohan/Mira-Dashboard/commit/7cdbd790a3c58bfc1a368bf7d0b1d07e00f40e5e))
* **greenfield:** close final parity ([#426](https://github.com/rajohan/Mira-Dashboard/issues/426)) ([8fffabc](https://github.com/rajohan/Mira-Dashboard/commit/8fffabc75c5d0e2e4c05e14d9510407f07f6646f))
* **greenfield:** close logs maintenance parity ([#416](https://github.com/rajohan/Mira-Dashboard/issues/416)) ([0803b8c](https://github.com/rajohan/Mira-Dashboard/commit/0803b8c5922a4d0e63a2c4fc25168c2b20b821a5))
* **greenfield:** close OpenClaw operations and media parity ([#421](https://github.com/rajohan/Mira-Dashboard/issues/421)) ([b548b3a](https://github.com/rajohan/Mira-Dashboard/commit/b548b3a0f9a6d7fe673fc8dce2952a3b222eb42f))
* **greenfield:** complete core operations overview ([#408](https://github.com/rajohan/Mira-Dashboard/issues/408)) ([b4cb644](https://github.com/rajohan/Mira-Dashboard/commit/b4cb644e7d496727ec3c94b6b20c79820bab5b9c))
* **greenfield:** complete durable OpenClaw chat ([#410](https://github.com/rajohan/Mira-Dashboard/issues/410)) ([bf15b83](https://github.com/rajohan/Mira-Dashboard/commit/bf15b83ea816c0db7bee5e9c60c61a03a34e5fa6))
* **greenfield:** complete final production readiness ([#436](https://github.com/rajohan/Mira-Dashboard/issues/436)) ([0adf471](https://github.com/rajohan/Mira-Dashboard/commit/0adf4718dcd44d947d10416bff7df4b29805e944))
* **greenfield:** consolidate Phase 5 operational parity ([#419](https://github.com/rajohan/Mira-Dashboard/issues/419)) ([f46cb70](https://github.com/rajohan/Mira-Dashboard/commit/f46cb7024159ada76466fd495a1e92fcbce465c2))
* **greenfield:** harden operator workflows and refresh UI ([#428](https://github.com/rajohan/Mira-Dashboard/issues/428)) ([c7aad60](https://github.com/rajohan/Mira-Dashboard/commit/c7aad60beeb5fcd4fedd18b6b900e0946eb916a8))
* **greenfield:** refine dashboard operational views ([#432](https://github.com/rajohan/Mira-Dashboard/issues/432)) ([5a649af](https://github.com/rajohan/Mira-Dashboard/commit/5a649af9d9bd68dfff4d51f40394572d97625f9b))
* **greenfield:** refresh operations UI and harden chat runtime ([#429](https://github.com/rajohan/Mira-Dashboard/issues/429)) ([2d3f2b3](https://github.com/rajohan/Mira-Dashboard/commit/2d3f2b39978f5c7f6ccf5cb702a3b8a58831f680))
* **greenfield:** replace generic exec with service actions ([#422](https://github.com/rajohan/Mira-Dashboard/issues/422)) ([90e03a8](https://github.com/rajohan/Mira-Dashboard/commit/90e03a8a6ed772720b6b8d08ac1e59971e4d471a))
* **greenfield:** unify infinite scroll lists ([#433](https://github.com/rajohan/Mira-Dashboard/issues/433)) ([de8e4aa](https://github.com/rajohan/Mira-Dashboard/commit/de8e4aae623e5c291c80b31a3098db0b040a703b))
* harden deployment and worker operations ([#351](https://github.com/rajohan/Mira-Dashboard/issues/351)) ([e50b738](https://github.com/rajohan/Mira-Dashboard/commit/e50b7383f2eee5c2a3f2e279f3bb97dab0ae0dde))
* **layout:** add mobile navigation drawer ([32a1325](https://github.com/rajohan/Mira-Dashboard/commit/32a1325baea6ddea660d8e29576a33fdc55bbeb8))
* link tasks to cron automation ([#2](https://github.com/rajohan/Mira-Dashboard/issues/2)) ([cafd4f1](https://github.com/rajohan/Mira-Dashboard/commit/cafd4f142240c458941feba3ac0cdd080e746bb8))
* monitor PostgreSQL bloat ([#273](https://github.com/rajohan/Mira-Dashboard/issues/273)) ([7bf8f04](https://github.com/rajohan/Mira-Dashboard/commit/7bf8f04b2d0b7fc354acbba6bcc524d40f1c546a))
* **platform:** establish greenfield process boundaries ([#392](https://github.com/rajohan/Mira-Dashboard/issues/392)) ([dc9d79c](https://github.com/rajohan/Mira-Dashboard/commit/dc9d79c057888901102acfeff198c956c5a9240c))
* polish delivery and content workflows ([#373](https://github.com/rajohan/Mira-Dashboard/issues/373)) ([744d0ed](https://github.com/rajohan/Mira-Dashboard/commit/744d0edb4c4c078cc69df1ccb75259559b1ef8ec))
* **rewrite:** add authenticated realtime transport ([#384](https://github.com/rajohan/Mira-Dashboard/issues/384)) ([74cbc2d](https://github.com/rajohan/Mira-Dashboard/commit/74cbc2d6b153c5f47d606e8c9cd0a7be79ed4c30))
* **rewrite:** add browser authentication lifecycle ([#386](https://github.com/rajohan/Mira-Dashboard/issues/386)) ([abb86a7](https://github.com/rajohan/Mira-Dashboard/commit/abb86a7d74386c783bb9b01aaab0ce321db0c0a7))
* **rewrite:** add durable jobs and worker foundation ([#401](https://github.com/rajohan/Mira-Dashboard/issues/401)) ([e7eb2c1](https://github.com/rajohan/Mira-Dashboard/commit/e7eb2c1d45dc56c4d739d23566d6a717ee85fa83))
* **rewrite:** add Effect-backed durable realtime event pump ([#383](https://github.com/rajohan/Mira-Dashboard/issues/383)) ([0416d0e](https://github.com/rajohan/Mira-Dashboard/commit/0416d0eec10797eee276383eff82dc00c23fa5bb))
* **rewrite:** add MFA and account security lifecycle ([#387](https://github.com/rajohan/Mira-Dashboard/issues/387)) ([33980c4](https://github.com/rajohan/Mira-Dashboard/commit/33980c41906a3521488b1e762b11e3e8cb78bbc3))
* **rewrite:** add Phase 3 agent directory ([#397](https://github.com/rajohan/Mira-Dashboard/issues/397)) ([b495425](https://github.com/rajohan/Mira-Dashboard/commit/b495425c4534b6a839045b9c9aa4a78b7fb413d2))
* **rewrite:** add Phase 3 cache browser foundation ([#404](https://github.com/rajohan/Mira-Dashboard/issues/404)) ([b3f8ffd](https://github.com/rajohan/Mira-Dashboard/commit/b3f8ffdf5c50e3dd93894c924cdcbe3539807a9c))
* **rewrite:** add Phase 3 cache foundation ([#403](https://github.com/rajohan/Mira-Dashboard/issues/403)) ([3aa6639](https://github.com/rajohan/Mira-Dashboard/commit/3aa6639afb5ee2c25f17d32c2410d78752685c50))
* **rewrite:** add Phase 3 jobs browser ([#402](https://github.com/rajohan/Mira-Dashboard/issues/402)) ([32a26b5](https://github.com/rajohan/Mira-Dashboard/commit/32a26b5ae0d2fb73ed8faa080df312b00a3a555f))
* **rewrite:** add Phase 3 monitoring browser readers ([#399](https://github.com/rajohan/Mira-Dashboard/issues/399)) ([662091d](https://github.com/rajohan/Mira-Dashboard/commit/662091d51d269941497f046ccdb9fa85fc344c8c))
* **rewrite:** add Phase 3 monitoring ingestion and catalogs ([#398](https://github.com/rajohan/Mira-Dashboard/issues/398)) ([cf34550](https://github.com/rajohan/Mira-Dashboard/commit/cf34550938725f58e80d7bb3c3a527b97e5985f0))
* **rewrite:** add Phase 3 notification center ([#400](https://github.com/rajohan/Mira-Dashboard/issues/400)) ([fe6d7bb](https://github.com/rajohan/Mira-Dashboard/commit/fe6d7bb4eef76fcf85e2b896906004968a23ab1b))
* **rewrite:** add Phase 3 task domain ([#396](https://github.com/rajohan/Mira-Dashboard/issues/396)) ([fabb909](https://github.com/rajohan/Mira-Dashboard/commit/fabb90911f67d51f6e7733e6c593f46de99556bd))
* **rewrite:** add security core and renewable auth leases ([#385](https://github.com/rajohan/Mira-Dashboard/issues/385)) ([d0112e3](https://github.com/rajohan/Mira-Dashboard/commit/d0112e3934ea2591fdb9cb7b4853b0f073d8cfdc))
* **rewrite:** complete greenfield production delivery foundation ([#394](https://github.com/rajohan/Mira-Dashboard/issues/394)) ([8c48ae3](https://github.com/rajohan/Mira-Dashboard/commit/8c48ae3ea2280746e7565f04503063d3a5bc0e88))
* **rewrite:** complete Phase 2 security and browser surface ([#395](https://github.com/rajohan/Mira-Dashboard/issues/395)) ([80991ab](https://github.com/rajohan/Mira-Dashboard/commit/80991abf3557f02a2ef593a1bf27f0763391d360))
* **rewrite:** implement monitoring incident lifecycle ([#382](https://github.com/rajohan/Mira-Dashboard/issues/382)) ([5bfdbfd](https://github.com/rajohan/Mira-Dashboard/commit/5bfdbfd351242435f42e7f08c2138cf1f08d23a7))
* **rewrite:** isolate future root and harden database runtime ([#393](https://github.com/rajohan/Mira-Dashboard/issues/393)) ([d277190](https://github.com/rajohan/Mira-Dashboard/commit/d2771907f2d602e94d1f2d428334f6670f2beca1))
* **rewrite:** qualify HTTPS rolling-release SSE ([#379](https://github.com/rajohan/Mira-Dashboard/issues/379)) ([f324333](https://github.com/rajohan/Mira-Dashboard/commit/f324333d3ce8bb7c54d68c5df7920bf44c8ac074))
* **security:** add automation credential lifecycle ([#389](https://github.com/rajohan/Mira-Dashboard/issues/389)) ([c5cb306](https://github.com/rajohan/Mira-Dashboard/commit/c5cb3060aa564e49d5d526a32c6a4d179744a48b))
* **security:** add native Gateway credential verification ([#390](https://github.com/rajohan/Mira-Dashboard/issues/390)) ([bcbdad4](https://github.com/rajohan/Mira-Dashboard/commit/bcbdad4e19938940fa2b731340cb640097689a90))
* **security:** add WebAuthn credential lifecycle ([#388](https://github.com/rajohan/Mira-Dashboard/issues/388)) ([31511af](https://github.com/rajohan/Mira-Dashboard/commit/31511af9eacd4cce65f0a09e90bcda899b7fe77b))
* **settings:** add OpenClaw configuration parity ([#420](https://github.com/rajohan/Mira-Dashboard/issues/420)) ([9ae9452](https://github.com/rajohan/Mira-Dashboard/commit/9ae945226294419af3b0f8cd433a1d5a43f1f572))
* show dependency pull requests in dashboard ([#15](https://github.com/rajohan/Mira-Dashboard/issues/15)) ([6897e8e](https://github.com/rajohan/Mira-Dashboard/commit/6897e8edd624b251a3921856bc0add1787ccf780))
* standardize contracts and observability ([#347](https://github.com/rajohan/Mira-Dashboard/issues/347)) ([7fe65b3](https://github.com/rajohan/Mira-Dashboard/commit/7fe65b3d1d2b1fd1afd72ff12315c8fae703cc2a))
* start greenfield Dashboard rewrite foundation ([#378](https://github.com/rajohan/Mira-Dashboard/issues/378)) ([9b98042](https://github.com/rajohan/Mira-Dashboard/commit/9b980429f4c5e1bdbf8c81aa7844927c4e88a63b))
* **tasks:** add task detail endpoint ([#33](https://github.com/rajohan/Mira-Dashboard/issues/33)) ([a923b80](https://github.com/rajohan/Mira-Dashboard/commit/a923b80b14bec36c268de07ab5e85a02debd6c08))
* **tasks:** broaden board search fields ([#56](https://github.com/rajohan/Mira-Dashboard/issues/56)) ([8369af0](https://github.com/rajohan/Mira-Dashboard/commit/8369af05a45c5df3e6bb5e5025147d1e4da7af79))
* **tasks:** support hash-prefixed task search ([#106](https://github.com/rajohan/Mira-Dashboard/issues/106)) ([1161228](https://github.com/rajohan/Mira-Dashboard/commit/11612289b7b9ccd06525745071c60c804e821097))
* **terminal:** provide a native operator shell ([#434](https://github.com/rajohan/Mira-Dashboard/issues/434)) ([5041c6a](https://github.com/rajohan/Mira-Dashboard/commit/5041c6a79bf565af9d27e61000193b1ba9c7654d))


### Bug Fixes

* **a11y:** associate cron edit labels ([bd8f92c](https://github.com/rajohan/Mira-Dashboard/commit/bd8f92cb57fd667f989fa7f8e490e7a67bc558e7))
* **a11y:** expose active agent access state ([#91](https://github.com/rajohan/Mira-Dashboard/issues/91)) ([0076157](https://github.com/rajohan/Mira-Dashboard/commit/0076157bab502435e83132e4f5568494686bc282))
* **a11y:** expose active sidebar route ([#81](https://github.com/rajohan/Mira-Dashboard/issues/81)) ([0ec8e53](https://github.com/rajohan/Mira-Dashboard/commit/0ec8e5361c676986c9b76972bc4b70d712841118))
* **a11y:** expose log level filter state ([#86](https://github.com/rajohan/Mira-Dashboard/issues/86)) ([c3bc094](https://github.com/rajohan/Mira-Dashboard/commit/c3bc094e21e6844c8e1cd9af32c7858c4a07de4e))
* **a11y:** expose notification filter state ([#75](https://github.com/rajohan/Mira-Dashboard/issues/75)) ([154856d](https://github.com/rajohan/Mira-Dashboard/commit/154856d668955f9832e7547f36297b4359c6a90d))
* **a11y:** expose selected filter states ([c00f9b5](https://github.com/rajohan/Mira-Dashboard/commit/c00f9b5fbebc7ba308f3b7c0f42c9856d5370181))
* **a11y:** label chat image preview controls ([#108](https://github.com/rajohan/Mira-Dashboard/issues/108)) ([93b07e4](https://github.com/rajohan/Mira-Dashboard/commit/93b07e4698f81f064fa7d45015fc09c88c93f7a6))
* **a11y:** label docker container actions ([0bba2e1](https://github.com/rajohan/Mira-Dashboard/commit/0bba2e1915fa8cd0ddfac4cdbf251974446c3bc4))
* **a11y:** label docker delete actions ([4ff1b82](https://github.com/rajohan/Mira-Dashboard/commit/4ff1b82033250c3ba0e7f63aefab8d4fa24e4c4d))
* **a11y:** label docker mobile container cards ([19a7521](https://github.com/rajohan/Mira-Dashboard/commit/19a7521379c133aff5993ce141624c6bd0c84299))
* **a11y:** label modal close buttons ([#65](https://github.com/rajohan/Mira-Dashboard/issues/65)) ([d3f5501](https://github.com/rajohan/Mira-Dashboard/commit/d3f5501314098f4e04a690d272cc0b9cb76de68a))
* **a11y:** label notification dropdown trigger ([#68](https://github.com/rajohan/Mira-Dashboard/issues/68)) ([bc24436](https://github.com/rajohan/Mira-Dashboard/commit/bc24436e55ac7c92cdba07e6bfd5d92625c7f474))
* **a11y:** label session action menus ([9bfe500](https://github.com/rajohan/Mira-Dashboard/commit/9bfe500fb9d4e8595b4f7689208249c6541ac278))
* **a11y:** label shared search inputs ([#90](https://github.com/rajohan/Mira-Dashboard/issues/90)) ([2ec6d22](https://github.com/rajohan/Mira-Dashboard/commit/2ec6d223465a342de26f47a66f80c988166b6b07))
* **a11y:** label task update controls ([#93](https://github.com/rajohan/Mira-Dashboard/issues/93)) ([67acc2e](https://github.com/rajohan/Mira-Dashboard/commit/67acc2e76767f11eeb202b561952b1b626cbae29))
* **a11y:** label terminal command controls ([#92](https://github.com/rajohan/Mira-Dashboard/issues/92)) ([db7fb7d](https://github.com/rajohan/Mira-Dashboard/commit/db7fb7d71c53d882b7931d349809666134b11916))
* **a11y:** make files sidebar keyboard accessible ([#76](https://github.com/rajohan/Mira-Dashboard/issues/76)) ([c6a9261](https://github.com/rajohan/Mira-Dashboard/commit/c6a92616e1ee36eb1318b4d70ebca4ac00b03c93))
* **a11y:** make task cards keyboard accessible ([#89](https://github.com/rajohan/Mira-Dashboard/issues/89)) ([7b9bf16](https://github.com/rajohan/Mira-Dashboard/commit/7b9bf16b6b3fee37b82419fdd93563d870be8f91))
* **a11y:** update mobile nav toggle label ([#79](https://github.com/rajohan/Mira-Dashboard/issues/79)) ([9f2a634](https://github.com/rajohan/Mira-Dashboard/commit/9f2a634e93768f6f4dbc635dc94432e325e7697c))
* **agents:** ignore noisy activity events ([#55](https://github.com/rajohan/Mira-Dashboard/issues/55)) ([72da8ae](https://github.com/rajohan/Mira-Dashboard/commit/72da8ae55f7177d4877031cf21dc20b0964d0040))
* **agents:** improve mobile layout ([2a03e31](https://github.com/rajohan/Mira-Dashboard/commit/2a03e31ef663859d7455539af56df2d2a5db3069))
* **agents:** read v4 activity state ([#53](https://github.com/rajohan/Mira-Dashboard/issues/53)) ([e473773](https://github.com/rajohan/Mira-Dashboard/commit/e473773b5bc36d017a37db320ff06dcbdfa2c426))
* **app:** clean favicon left edge ([83c7a1e](https://github.com/rajohan/Mira-Dashboard/commit/83c7a1ee4390560d60f2d98bb9703c84574c7ba8))
* **app:** clean generated favicon crop ([4fa8fe8](https://github.com/rajohan/Mira-Dashboard/commit/4fa8fe8d55934d565f581288dccf4c08aeafad4e))
* **app:** erode favicon left edge ([ac27b46](https://github.com/rajohan/Mira-Dashboard/commit/ac27b469054984122e6f04aa1a1a23fc2d80f53e))
* **app:** inset favicon mark ([66d78c9](https://github.com/rajohan/Mira-Dashboard/commit/66d78c9512b2b4d0c03918a79907b95e29ab097b))
* **app:** remove favicon rim ([f833bd2](https://github.com/rajohan/Mira-Dashboard/commit/f833bd27f371234e6d7461c3ff29bf1c5208eebe))
* **app:** replace dashboard favicon ([46bd82e](https://github.com/rajohan/Mira-Dashboard/commit/46bd82e336f7ddf1428cb9e7a3fff1b23c08eecc))
* **app:** set dashboard title and favicon ([1305985](https://github.com/rajohan/Mira-Dashboard/commit/1305985d114c63ee36c67cf0b8a5758252e129de))
* **app:** use selected generated favicon ([01f05cb](https://github.com/rajohan/Mira-Dashboard/commit/01f05cbc84ede6fb9df209b73e5e5fdd33c933d1))
* avoid inferring cron links from stray uuids ([#3](https://github.com/rajohan/Mira-Dashboard/issues/3)) ([232ae6a](https://github.com/rajohan/Mira-Dashboard/commit/232ae6a5df6aa0dfd427f78f2bd74ef0bacc7110))
* **backend:** complete coverage hardening review ([#119](https://github.com/rajohan/Mira-Dashboard/issues/119)) ([9c449df](https://github.com/rajohan/Mira-Dashboard/commit/9c449df7108e33f38e37bec7a695915132da7108))
* **chat:** attach sessions to compaction events ([90c44c9](https://github.com/rajohan/Mira-Dashboard/commit/90c44c9dd0aa2d93b5f8f53df6923350dd1aea53))
* **chat:** clear stale typing and stream state ([10738aa](https://github.com/rajohan/Mira-Dashboard/commit/10738aa05a640eabe1311027fdf9885ac9963adb))
* **chat:** clear stale typing indicator ([307d586](https://github.com/rajohan/Mira-Dashboard/commit/307d58635c6e932055c44c376592572f53974fb9))
* **chat:** clear typing state on gateway reconnect ([47a6523](https://github.com/rajohan/Mira-Dashboard/commit/47a65237207d72a2ca5a945f727f424dfdfb65b3))
* **chat:** dedupe displayed messages ([9215da1](https://github.com/rajohan/Mira-Dashboard/commit/9215da19d1c9b81e16440b1b5d4b8d78508796fd))
* **chat:** default to main chat session ([db37774](https://github.com/rajohan/Mira-Dashboard/commit/db37774d1f8f95ba6f8b65f6343601465aa21a40))
* **chat:** follow virtualizer resize at bottom ([c8c9250](https://github.com/rajohan/Mira-Dashboard/commit/c8c925045f04b2b3269ccac8297358843fbeba3a))
* **chat:** harden replay identity under generated faults ([#353](https://github.com/rajohan/Mira-Dashboard/issues/353)) ([66a16df](https://github.com/rajohan/Mira-Dashboard/commit/66a16df4178c7f645cb3cad7300db6fa0905ed0d))
* **chat:** improve mobile emoji picker ([a9956e7](https://github.com/rajohan/Mira-Dashboard/commit/a9956e776dd20285aa69296dc499186121f34fab))
* **chat:** improve mobile layout ([a5b5bba](https://github.com/rajohan/Mira-Dashboard/commit/a5b5bba15bfa47d915c85e2323ed1c98a88551b7))
* **chat:** keep bottom scroll sticky ([68d0b66](https://github.com/rajohan/Mira-Dashboard/commit/68d0b66da67342fd8ee6abe411df2be316ab53c2))
* **chat:** keep explicit session selection stable ([#362](https://github.com/rajohan/Mira-Dashboard/issues/362)) ([a32c67a](https://github.com/rajohan/Mira-Dashboard/commit/a32c67a4cf89a44fe21a44cf8918ab13a8bfe9aa))
* **chat:** keep typing indicator stable during long runs ([800c1ee](https://github.com/rajohan/Mira-Dashboard/commit/800c1eefbc820e825a043cd666c97554c288df20))
* **chat:** keep working indicator aligned with streaming ([6da3a37](https://github.com/rajohan/Mira-Dashboard/commit/6da3a37ef23985d00612b01df2bac0597625bca5))
* **chat:** pass through OpenClaw slash commands ([#128](https://github.com/rajohan/Mira-Dashboard/issues/128)) ([5508223](https://github.com/rajohan/Mira-Dashboard/commit/5508223465509e53d6aa0a46f81314eb8ecb7ebc))
* **chat:** persist diagnostics and preserve scroll position ([e3aa2b8](https://github.com/rajohan/Mira-Dashboard/commit/e3aa2b822ba88a663a893246bf093387cf5da427))
* **chat:** polish diagnostics toggles and local message order ([6629978](https://github.com/rajohan/Mira-Dashboard/commit/66299785081bb0a8eca0222903a98b1dbfe6327c))
* **chat:** poll visible history for live parity ([d2dafac](https://github.com/rajohan/Mira-Dashboard/commit/d2dafac1589783056934ad0081655cd57e6b947c))
* **chat:** prefer interactive sessions by default ([06cde66](https://github.com/rajohan/Mira-Dashboard/commit/06cde664e535182a39273462bd20fd668d97f068))
* **chat:** preserve interrupted run identity ([#306](https://github.com/rajohan/Mira-Dashboard/issues/306)) ([a743cef](https://github.com/rajohan/Mira-Dashboard/commit/a743cefb6284457101ebd04b80973e86cd32e620))
* **chat:** preserve sent messages during active replies ([#95](https://github.com/rajohan/Mira-Dashboard/issues/95)) ([ff57a6d](https://github.com/rajohan/Mira-Dashboard/commit/ff57a6d4fdbbba70f7295040725e3b4b86df4176))
* **chat:** preserve streamed assistant whitespace ([#371](https://github.com/rajohan/Mira-Dashboard/issues/371)) ([94e55ea](https://github.com/rajohan/Mira-Dashboard/commit/94e55ea9995113a370fe8b7d6ea5f8f124984f9d))
* **chat:** prevent duplicate sends ([2dca2e6](https://github.com/rajohan/Mira-Dashboard/commit/2dca2e6f140313c6b835e9129e977add2a8e773c))
* **chat:** refresh diagnostics during live runs ([82e9005](https://github.com/rajohan/Mira-Dashboard/commit/82e9005fd46da5334f0f51d5df9014ad54f1a803))
* **chat:** remove virtualized message list ([8f11746](https://github.com/rajohan/Mira-Dashboard/commit/8f117463b500503bb9d777907d768288c0cca48c))
* **chat:** render status beside streaming responses ([c770ce5](https://github.com/rajohan/Mira-Dashboard/commit/c770ce5b0828b698dd1984d8d7f2128b648ffe15))
* **chat:** reset stale stream state on new runs ([14ca973](https://github.com/rajohan/Mira-Dashboard/commit/14ca973a786b073ce33e976cdfe86a2c6f0f60e8))
* **chat:** restore virtualized bottom follow ([fbacd4d](https://github.com/rajohan/Mira-Dashboard/commit/fbacd4d8a9670d2e84e0d073337488ce078d12ff))
* **chat:** separate attachment remove controls ([2cf0cc8](https://github.com/rajohan/Mira-Dashboard/commit/2cf0cc818cc407dc2c298cb85e57289ea2fd1161))
* **chat:** show run metadata and typing state ([553adca](https://github.com/rajohan/Mira-Dashboard/commit/553adca66eaa4e3acf0e844db299a4d2c7dbecde))
* **chat:** simplify delete confirmation copy ([3783ae2](https://github.com/rajohan/Mira-Dashboard/commit/3783ae2313cb217fbcb2667928d13635ec6c155d))
* **chat:** smooth mobile live updates ([fe24fa9](https://github.com/rajohan/Mira-Dashboard/commit/fe24fa97abe63a1359c9f34e2252f1f6c1c0ccb9))
* **chat:** stabilize replay and control events ([#365](https://github.com/rajohan/Mira-Dashboard/issues/365)) ([d32705a](https://github.com/rajohan/Mira-Dashboard/commit/d32705ab5ae8b2c4a23da0a134deb005666f3f03))
* **chat:** stabilize scroll after idle refresh ([e734fa2](https://github.com/rajohan/Mira-Dashboard/commit/e734fa2b7e4e5064c91c56fabcfc1eecbd72a4e7))
* **chat:** stabilize typing and pointer states ([1fc7840](https://github.com/rajohan/Mira-Dashboard/commit/1fc78400984fe513ea02264c3160c062ee2be85e))
* **chat:** sync slash command suggestions ([#127](https://github.com/rajohan/Mira-Dashboard/issues/127)) ([3e285de](https://github.com/rajohan/Mira-Dashboard/commit/3e285def8a56de4f5038db12074acadbdc736741))
* **chat:** tighten markdown spacing ([cf33d13](https://github.com/rajohan/Mira-Dashboard/commit/cf33d13fedc1019c761e55a7d1d63c64137c5a8e))
* **chat:** use dashboard confirm for message deletion ([cbbef8c](https://github.com/rajohan/Mira-Dashboard/commit/cbbef8cbe4e4df7ede5ac0cf6edd1978ca7ca839))
* clean up dashboard pr worktrees ([#9](https://github.com/rajohan/Mira-Dashboard/issues/9)) ([b9ea578](https://github.com/rajohan/Mira-Dashboard/commit/b9ea578dd86d83de561ecabb5814ac2fb13d01e4))
* compact heartbeat cache payload ([#270](https://github.com/rajohan/Mira-Dashboard/issues/270)) ([38aaf8a](https://github.com/rajohan/Mira-Dashboard/commit/38aaf8afd48905643a891f0bf5445b0dfb0cbe14))
* complete SQLite maintenance coverage ([#319](https://github.com/rajohan/Mira-Dashboard/issues/319)) ([3b7a50b](https://github.com/rajohan/Mira-Dashboard/commit/3b7a50bf428059f9e79e3a69771bc3652374207e))
* consolidate Dashboard runtime paths and delivery state ([#342](https://github.com/rajohan/Mira-Dashboard/issues/342)) ([97ae255](https://github.com/rajohan/Mira-Dashboard/commit/97ae255d27a9c88bfbe6e9996a625d7c42419106))
* consolidate database torrent cache ([#274](https://github.com/rajohan/Mira-Dashboard/issues/274)) ([4805903](https://github.com/rajohan/Mira-Dashboard/commit/48059034dcd2cfc2e63e065ad5e0b16092c7e5f0))
* correct heartbeat cutover authority ([#427](https://github.com/rajohan/Mira-Dashboard/issues/427)) ([1f86ca9](https://github.com/rajohan/Mira-Dashboard/commit/1f86ca9dcba11b90af32ed7b746f748a96b92cef))
* **cron:** classify completed statuses as successful ([#105](https://github.com/rajohan/Mira-Dashboard/issues/105)) ([018bbe8](https://github.com/rajohan/Mira-Dashboard/commit/018bbe86232c13e93494d0c6213c2c7c898830a7))
* **cron:** improve mobile layout ([32d870a](https://github.com/rajohan/Mira-Dashboard/commit/32d870a990f3aaeec4db5c0edab2d9de1b77892d))
* **cron:** normalize runtime status fallbacks ([#102](https://github.com/rajohan/Mira-Dashboard/issues/102)) ([cd63532](https://github.com/rajohan/Mira-Dashboard/commit/cd6353224bc37a04e150139b94f3c1207cb0894a))
* **dashboard:** align desktop card grid ([0d6adce](https://github.com/rajohan/Mira-Dashboard/commit/0d6adce7bef9d8da33ca5817bba279b441b4d004))
* **dashboard:** align weather forecast icon ([1c5eede](https://github.com/rajohan/Mira-Dashboard/commit/1c5eede854d45220c635821afe51be23aed03efa))
* **dashboard:** guard cache timestamp display ([#114](https://github.com/rajohan/Mira-Dashboard/issues/114)) ([1b48648](https://github.com/rajohan/Mira-Dashboard/commit/1b486482ec500c1a370b4d5b0e0a4c3c2e481ab8))
* **dashboard:** improve mobile layout ([b8734d8](https://github.com/rajohan/Mira-Dashboard/commit/b8734d84b03c89bfd951f24cc4069ad592d3ef0b))
* **database:** guard invalid metric counts ([#118](https://github.com/rajohan/Mira-Dashboard/issues/118)) ([83d0a37](https://github.com/rajohan/Mira-Dashboard/commit/83d0a37963553b18c5f3ad34f00effd69999de35))
* **database:** improve mobile layout ([2de70cb](https://github.com/rajohan/Mira-Dashboard/commit/2de70cbfd1d0d8af0acf27d1483c96bca7a8ab48))
* dedupe exact live assistant replies ([549c323](https://github.com/rajohan/Mira-Dashboard/commit/549c323e96be7633e0256e746e977296b2e4746d))
* deduplicate heartbeat incident notifications ([#377](https://github.com/rajohan/Mira-Dashboard/issues/377)) ([e23e5a1](https://github.com/rajohan/Mira-Dashboard/commit/e23e5a15085fedafb2754594e2b300aa0cba4f50))
* **docker:** improve mobile layout ([1d1d7cd](https://github.com/rajohan/Mira-Dashboard/commit/1d1d7cdef45540514ad07ba1c4465368be6f8805))
* **docker:** normalize zero memory usage ([#115](https://github.com/rajohan/Mira-Dashboard/issues/115)) ([ee72176](https://github.com/rajohan/Mira-Dashboard/commit/ee72176a4639ec1e819293de229cafa28db29e27))
* **docker:** surface action feedback ([f982bfa](https://github.com/rajohan/Mira-Dashboard/commit/f982bfa6ec681b0dbc6812dd5b0713ac22a7176f))
* expose Bun to nested release scripts ([#348](https://github.com/rajohan/Mira-Dashboard/issues/348)) ([ed01feb](https://github.com/rajohan/Mira-Dashboard/commit/ed01febf9384353d616267eaabf55a04bc026832))
* **files:** avoid mutating file tree children ([#113](https://github.com/rajohan/Mira-Dashboard/issues/113)) ([954fc81](https://github.com/rajohan/Mira-Dashboard/commit/954fc811a649ac475e1d07329a9e2aad9cf72a12))
* **files:** close reviewed Files boundary ([#418](https://github.com/rajohan/Mira-Dashboard/issues/418)) ([cf0291b](https://github.com/rajohan/Mira-Dashboard/commit/cf0291b7f8c8fd9c398e3ad18fa3017ac68319af))
* **files:** improve mobile layout ([ea36251](https://github.com/rajohan/Mira-Dashboard/commit/ea362511b747145b12895ae468a3819366ba0497))
* **files:** remove migrated cron config entry ([#122](https://github.com/rajohan/Mira-Dashboard/issues/122)) ([26b26e5](https://github.com/rajohan/Mira-Dashboard/commit/26b26e5c6491cb88caf7b23b4ef77c038ffd852d))
* **frontend:** preserve generated app entrypoint ([#345](https://github.com/rajohan/Mira-Dashboard/issues/345)) ([6cb015e](https://github.com/rajohan/Mira-Dashboard/commit/6cb015e44f60bf2deac8bab7d88cd7d11a204eee))
* harden sessions and logs data handling ([0b9ba27](https://github.com/rajohan/Mira-Dashboard/commit/0b9ba27eb38e29a2d99c1ac3f56a01471bbd1113))
* **header:** hide version mismatch on mobile ([c2e4725](https://github.com/rajohan/Mira-Dashboard/commit/c2e47252c5a53cfacee344be6e8ab4f76641aea0))
* improve chat reset and mobile compose UX ([9d3f79e](https://github.com/rajohan/Mira-Dashboard/commit/9d3f79eb22122bc28837110866c8b40241cd63e7))
* improve chat scroll cues and task notifications ([#374](https://github.com/rajohan/Mira-Dashboard/issues/374)) ([0372a40](https://github.com/rajohan/Mira-Dashboard/commit/0372a40e1eea00ecd0359f64a2e2ce9ced0b32c6))
* isolate dashboard deploys from pr worktrees ([#8](https://github.com/rajohan/Mira-Dashboard/issues/8)) ([0b28425](https://github.com/rajohan/Mira-Dashboard/commit/0b2842591aa56de6b1da6f51f29ffa6c0ff4c737))
* keep pull request JSON untruncated ([#16](https://github.com/rajohan/Mira-Dashboard/issues/16)) ([5803e4d](https://github.com/rajohan/Mira-Dashboard/commit/5803e4d1c8b7788c839e2afe671b7ea23a8eacb1))
* keep task columns scrollable ([#317](https://github.com/rajohan/Mira-Dashboard/issues/317)) ([a2ab85e](https://github.com/rajohan/Mira-Dashboard/commit/a2ab85e742b2a6d26035524bb8297793bb8c048a))
* **layout:** show OpenClaw version in footer ([64324f1](https://github.com/rajohan/Mira-Dashboard/commit/64324f1392b1134136c5459c8af537ae7d19dc00))
* **logs:** exclude journal wrapper records ([#372](https://github.com/rajohan/Mira-Dashboard/issues/372)) ([716493d](https://github.com/rajohan/Mira-Dashboard/commit/716493da9ab06d836b15def40d7e659d0aca722a))
* **logs:** guard log file names during navigation ([b91ed46](https://github.com/rajohan/Mira-Dashboard/commit/b91ed46d67bc9abaf75533d11e0ac586c4c20235))
* **logs:** improve mobile layout ([c122948](https://github.com/rajohan/Mira-Dashboard/commit/c122948fcdc5522e8d1d1618c8d62e817848b46c))
* **logs:** keep file dropdown options after navigation ([9f4ada2](https://github.com/rajohan/Mira-Dashboard/commit/9f4ada2c03d6f7699d9e9f0793b14857a3ef9d32))
* **logs:** preserve loaded file options ([65650a9](https://github.com/rajohan/Mira-Dashboard/commit/65650a95bff3f719f72e9d5edc219c1d3039194b))
* **logs:** restore file dropdown from loaded data ([ec7dfea](https://github.com/rajohan/Mira-Dashboard/commit/ec7dfeaa3fcd7de34d65ec1eb8a7b0dbf9eac795))
* **logs:** retain file options across page remounts ([5a730a9](https://github.com/rajohan/Mira-Dashboard/commit/5a730a95d4bdb111d82c378d9dc8aa9ec183f453))
* **logs:** reuse file list across remounts ([e55a00d](https://github.com/rajohan/Mira-Dashboard/commit/e55a00d6e844a403c7bcc0752103fd428ff778fb))
* **moltbook:** guard invalid timestamps ([#107](https://github.com/rajohan/Mira-Dashboard/issues/107)) ([4048225](https://github.com/rajohan/Mira-Dashboard/commit/40482252dd2e3f17f7f7be0baf490af1b9a6cdcd))
* **moltbook:** improve mobile layout ([2147f74](https://github.com/rajohan/Mira-Dashboard/commit/2147f745585af895bccbbf699fa093a00182f3af))
* **notifications:** disable inactive bulk actions ([992f3cf](https://github.com/rajohan/Mira-Dashboard/commit/992f3cf35e7d73b1cef4517f7855bc0911cb7922))
* **notifications:** handle malformed timestamps ([#109](https://github.com/rajohan/Mira-Dashboard/issues/109)) ([ba06298](https://github.com/rajohan/Mira-Dashboard/commit/ba062982f3a7e8a290b1c1c5fa9da82e83e75e02))
* preserve chat replay across auto-compaction ([#368](https://github.com/rajohan/Mira-Dashboard/issues/368)) ([84474ca](https://github.com/rajohan/Mira-Dashboard/commit/84474ca27f4068d3e41b9a8b7ec0e0169bd30d8e))
* preserve task update author on edit ([#231](https://github.com/rajohan/Mira-Dashboard/issues/231)) ([5b80b18](https://github.com/rajohan/Mira-Dashboard/commit/5b80b1819f0c7f5e065a8bcfadfdd3b461d8f32b))
* prevent duplicate chat finals and tool-order flicker ([#370](https://github.com/rajohan/Mira-Dashboard/issues/370)) ([91257ba](https://github.com/rajohan/Mira-Dashboard/commit/91257ba33d6d8c79f00c6f4f3384dea755a9e9ad))
* **prs:** align recent deploys with external prs ([#123](https://github.com/rajohan/Mira-Dashboard/issues/123)) ([e4534bb](https://github.com/rajohan/Mira-Dashboard/commit/e4534bbf9e32f501a88a706a091c7bb84be77f9d))
* **prs:** block actions when checkout is off main ([104bfab](https://github.com/rajohan/Mira-Dashboard/commit/104bfabdd9f6b69270d058c6a17895d96b32680a))
* **prs:** clarify incomplete check summaries ([#112](https://github.com/rajohan/Mira-Dashboard/issues/112)) ([d37ed12](https://github.com/rajohan/Mira-Dashboard/commit/d37ed124db5c3391fc92d8544e52cdb4fd5d0b08))
* **prs:** clarify merge state display ([#120](https://github.com/rajohan/Mira-Dashboard/issues/120)) ([204aa1e](https://github.com/rajohan/Mira-Dashboard/commit/204aa1e534fd9b3e35e4f3e24172c1e22a3dee84))
* **prs:** link recent deploy commits ([#126](https://github.com/rajohan/Mira-Dashboard/issues/126)) ([2b02e9f](https://github.com/rajohan/Mira-Dashboard/commit/2b02e9ffdd70b1a6ffab4b08cb41166985ac16f3))
* **prs:** require passing checks before dashboard merge ([794783e](https://github.com/rajohan/Mira-Dashboard/commit/794783e2e16db401389968e4dcb7da9b38e4342c))
* **prs:** show all open dashboard pull requests ([#44](https://github.com/rajohan/Mira-Dashboard/issues/44)) ([70d9976](https://github.com/rajohan/Mira-Dashboard/commit/70d99760775488e291b03e11071e39361ad858c9))
* **prs:** show review state and block draft merges ([#59](https://github.com/rajohan/Mira-Dashboard/issues/59)) ([2641ffc](https://github.com/rajohan/Mira-Dashboard/commit/2641ffc42521f95f298f6e66a1d2dc86c67f8d73))
* **quotas:** update provider quota surfaces ([#94](https://github.com/rajohan/Mira-Dashboard/issues/94)) ([7302b27](https://github.com/rajohan/Mira-Dashboard/commit/7302b2767ef1a1834b42d2f3ed33e217f78d88c5))
* refresh dashboard queue on manual actions ([#316](https://github.com/rajohan/Mira-Dashboard/issues/316)) ([3553951](https://github.com/rajohan/Mira-Dashboard/commit/3553951adc590f852ffa26ca4b85e2948ff6d936))
* **release:** authenticate release automation with GitHub App ([820a373](https://github.com/rajohan/Mira-Dashboard/commit/820a37391ae1673cba42c07b613d49e57fd26a34))
* remove noisy session action logging ([#11](https://github.com/rajohan/Mira-Dashboard/issues/11)) ([2bcc741](https://github.com/rajohan/Mira-Dashboard/commit/2bcc741213976ecd46829ffb1c627077d0d0dddb))
* render github-style pull request bodies ([#18](https://github.com/rajohan/Mira-Dashboard/issues/18)) ([04056b2](https://github.com/rajohan/Mira-Dashboard/commit/04056b2e21b6dbe9e102ceae64699f98cad1f4da))
* render pull request descriptions as markdown ([#17](https://github.com/rajohan/Mira-Dashboard/issues/17)) ([cd46bab](https://github.com/rajohan/Mira-Dashboard/commit/cd46babe3044134bbac7d929a03607ce9dead937))
* require explicit task automation links ([#6](https://github.com/rajohan/Mira-Dashboard/issues/6)) ([5813f81](https://github.com/rajohan/Mira-Dashboard/commit/5813f81bc4084d02e3fee61eb6ded6e613f90891))
* resolve Bun for managed PR dev ([#339](https://github.com/rajohan/Mira-Dashboard/issues/339)) ([d2c5a85](https://github.com/rajohan/Mira-Dashboard/commit/d2c5a854d376c48e32d55b2c38e51adcd8ceffdc))
* resolve Bun for managed release builds ([#338](https://github.com/rajohan/Mira-Dashboard/issues/338)) ([a0578f5](https://github.com/rajohan/Mira-Dashboard/commit/a0578f55b3cbc2adef48dee4f9f5e7515df24da0))
* restore exact release slots after failed deploy ([#340](https://github.com/rajohan/Mira-Dashboard/issues/340)) ([f8b8df4](https://github.com/rajohan/Mira-Dashboard/commit/f8b8df46a594b8baada335937aead59797ddefba))
* run each release on its exact Bun runtime ([#349](https://github.com/rajohan/Mira-Dashboard/issues/349)) ([70c505c](https://github.com/rajohan/Mira-Dashboard/commit/70c505c0ff12201cc2da25f72e8042424baa5153))
* **security:** address CodeQL alerts ([29606b0](https://github.com/rajohan/Mira-Dashboard/commit/29606b03478e6b815eddd7264a58d0897718f952))
* **security:** address remaining CodeQL alerts ([270654d](https://github.com/rajohan/Mira-Dashboard/commit/270654d6e198884b822afbf2e22530dbf8acb2d1))
* **security:** bound gateway tick watchdog cadence ([0755ea3](https://github.com/rajohan/Mira-Dashboard/commit/0755ea33c19a717ea5f741e5f7046944c822438f))
* **security:** harden dashboard trust boundaries ([#364](https://github.com/rajohan/Mira-Dashboard/issues/364)) ([30fca6d](https://github.com/rajohan/Mira-Dashboard/commit/30fca6de0ed13a164e30fd841be059c6a1c18e03))
* **sessions:** align feed bubbles with chat ([d2c450a](https://github.com/rajohan/Mira-Dashboard/commit/d2c450a5712c8c3b9fa7df665f7fd3b51068398d))
* **sessions:** avoid inactive history query crash ([b9ed1c6](https://github.com/rajohan/Mira-Dashboard/commit/b9ed1c6cadb67132dcb54d6a183b0d47115c2e26))
* **sessions:** avoid infinite query history crash ([a90f70d](https://github.com/rajohan/Mira-Dashboard/commit/a90f70d3c65d9c6317a1cc737f5c27edc08a9e2b))
* **sessions:** clear invalid infinite history cache ([66399e6](https://github.com/rajohan/Mira-Dashboard/commit/66399e6bb8714edf878b102294f803d38d0d9ea0))
* **sessions:** close delete modal immediately ([048e42e](https://github.com/rajohan/Mira-Dashboard/commit/048e42e9a82a3256254aadd0f061b0f72258ab97))
* **sessions:** delete sessions through gateway ([316eba4](https://github.com/rajohan/Mira-Dashboard/commit/316eba493fd70b1dac9066360c96058229f00b91))
* **sessions:** guard history modal remount state ([1e699b7](https://github.com/rajohan/Mira-Dashboard/commit/1e699b7cdd20c7b6f568764bc81e953a426fb8da))
* **sessions:** improve mobile layout ([1191e43](https://github.com/rajohan/Mira-Dashboard/commit/1191e43b5561838fe91256694b3d03a926a85d30))
* **sessions:** keep delete modal closed after success ([8e48d30](https://github.com/rajohan/Mira-Dashboard/commit/8e48d30a598a91905fe79af2a71c5ed22853470b))
* **sessions:** load modal history immediately ([a867e39](https://github.com/rajohan/Mira-Dashboard/commit/a867e39975b7e9b5acf39edf164a9f50adaaafb3))
* **sessions:** make local delete idempotent ([6db7cdc](https://github.com/rajohan/Mira-Dashboard/commit/6db7cdc7549b640c51e77325b130e1c2bc8600ce))
* **sessions:** remove live feed ([#54](https://github.com/rajohan/Mira-Dashboard/issues/54)) ([bdd4e84](https://github.com/rajohan/Mira-Dashboard/commit/bdd4e84922e1376bde69adb1d31e2109189f1957))
* **sessions:** render live feed viewport ([02fe5be](https://github.com/rajohan/Mira-Dashboard/commit/02fe5be74ed16ecd74aebf9a4d0caab5aeca1744))
* **sessions:** restore feed badge variants ([9adc3d5](https://github.com/rajohan/Mira-Dashboard/commit/9adc3d58c2f0770e152af2970d6eee1016600d8b))
* **sessions:** seed infinite history with valid state ([c1d6a23](https://github.com/rajohan/Mira-Dashboard/commit/c1d6a239247d2a01587fe62cafa69e19eb9f6de8))
* **sessions:** stabilize infinite history query ([d6b15fe](https://github.com/rajohan/Mira-Dashboard/commit/d6b15fe4c7d808c84f45ba502ab54b9156364066))
* **sessions:** stabilize live feed scrolling ([0e38d5e](https://github.com/rajohan/Mira-Dashboard/commit/0e38d5e95262d96c717e8dc4bbfd80cc99e973ef))
* **sessions:** use full-width dark feed bubbles ([5f625e4](https://github.com/rajohan/Mira-Dashboard/commit/5f625e4c2d339b44fa812a972779b1fdc78d3669))
* **settings:** improve mobile layout ([88de5cf](https://github.com/rajohan/Mira-Dashboard/commit/88de5cf7a5a604b47f8a653aaae1e5578e9f1d9b))
* **settings:** show runtime OpenClaw version ([8a5773d](https://github.com/rajohan/Mira-Dashboard/commit/8a5773dd99cb25adfcc5d48f315c05b11b2d0cb6))
* sort done tasks by latest update ([#7](https://github.com/rajohan/Mira-Dashboard/issues/7)) ([bf2f77b](https://github.com/rajohan/Mira-Dashboard/commit/bf2f77b4edf8deb7c6f3ccaee12e9a3947ee99a4))
* stop tracking removed n8n repository ([#216](https://github.com/rajohan/Mira-Dashboard/issues/216)) ([ef69b68](https://github.com/rajohan/Mira-Dashboard/commit/ef69b68633862952c698203af98c80064d8f87ae))
* **styles:** load Tailwind config in v4 ([8582839](https://github.com/rajohan/Mira-Dashboard/commit/8582839e657e7170699158b67f8cdb456de0fbe5))
* support keyboard activation for database rows ([#24](https://github.com/rajohan/Mira-Dashboard/issues/24)) ([ebdad11](https://github.com/rajohan/Mira-Dashboard/commit/ebdad1101eb04fb2db50d81ad0e3e2bf7efd0255))
* **tasks:** improve mobile layout ([5454aa7](https://github.com/rajohan/Mira-Dashboard/commit/5454aa7bd6cde8469375a6e0ba6ce51fab69c58e))
* **tasks:** keep blocked tasks out of in-progress column ([#130](https://github.com/rajohan/Mira-Dashboard/issues/130)) ([a85665e](https://github.com/rajohan/Mira-Dashboard/commit/a85665e91721ba2ab63904f8662fd3949c6ccb23))
* **tasks:** keep detail modal hooks stable ([#58](https://github.com/rajohan/Mira-Dashboard/issues/58)) ([e82875e](https://github.com/rajohan/Mira-Dashboard/commit/e82875e18fcc540e1a3664b0c7b8a90ba30201b0))
* **tasks:** keep recurring badge with cron status ([#99](https://github.com/rajohan/Mira-Dashboard/issues/99)) ([ee7504a](https://github.com/rajohan/Mira-Dashboard/commit/ee7504a37ef39592fd9c3bd8e0cb7a2189291036))
* **tasks:** reset detail edit state on task switch ([#129](https://github.com/rajohan/Mira-Dashboard/issues/129)) ([1157cc6](https://github.com/rajohan/Mira-Dashboard/commit/1157cc6f79d289408788663e0b340293a1e7f200))
* **tasks:** show cron status on task cards ([#98](https://github.com/rajohan/Mira-Dashboard/issues/98)) ([b697e0c](https://github.com/rajohan/Mira-Dashboard/commit/b697e0c3d4d63bd6aeb7aaea3d1c24f687557a35))
* **tasks:** show empty filtered board state ([#133](https://github.com/rajohan/Mira-Dashboard/issues/133)) ([8fa7ec1](https://github.com/rajohan/Mira-Dashboard/commit/8fa7ec120b1f56929687f21e8b30e55188dfe33f))
* **tasks:** stabilize malformed date sorting ([#110](https://github.com/rajohan/Mira-Dashboard/issues/110)) ([2e03ed5](https://github.com/rajohan/Mira-Dashboard/commit/2e03ed52a634fed7429ece46a95088f28cab08e7))
* **terminal:** improve mobile layout ([4fda377](https://github.com/rajohan/Mira-Dashboard/commit/4fda377f371c2ceb40f69c5f15eb1e03b3c17d2a))
* **terminal:** prevent mobile input zoom ([8186f0c](https://github.com/rajohan/Mira-Dashboard/commit/8186f0c0fb94afc3192e386ec6c0ea4f23bf3854))
* **ui:** add missing action icons ([#131](https://github.com/rajohan/Mira-Dashboard/issues/131)) ([565c3e3](https://github.com/rajohan/Mira-Dashboard/commit/565c3e346d473b91de2ee08d3154c4d9eb404d7a))
* **ui:** format large byte sizes ([#111](https://github.com/rajohan/Mira-Dashboard/issues/111)) ([9fce636](https://github.com/rajohan/Mira-Dashboard/commit/9fce63647b1ffe550ae9ff9e5cf379bc4a143769))
* **ui:** normalize action icon spacing ([#124](https://github.com/rajohan/Mira-Dashboard/issues/124)) ([ee6f11f](https://github.com/rajohan/Mira-Dashboard/commit/ee6f11fe408808d428ae016e61a5ef5c870bc163))
* **ui:** preserve scroll anchors during live updates ([e613a60](https://github.com/rajohan/Mira-Dashboard/commit/e613a605d0376aa1b632f9a92928bc215a03b3f5))
* use Mira token for PR workflow gh calls ([#5](https://github.com/rajohan/Mira-Dashboard/issues/5)) ([926cb03](https://github.com/rajohan/Mira-Dashboard/commit/926cb03702d7335f0d8c683a181912b880198cde))


### Performance Improvements

* coalesce polling snapshots ([#343](https://github.com/rajohan/Mira-Dashboard/issues/343)) ([96f613d](https://github.com/rajohan/Mira-Dashboard/commit/96f613d224f58731cf732b5f40cb54192914283d))
* lazy-load and cache frontend assets ([#344](https://github.com/rajohan/Mira-Dashboard/issues/344)) ([195e665](https://github.com/rajohan/Mira-Dashboard/commit/195e665d87fe51fd3a31d78646fae020bf64b3e7))

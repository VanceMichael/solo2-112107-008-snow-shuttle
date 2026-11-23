# 雪场联运接驳的实乘证据与过站补救

民宿夜班客服用团单、运营方公告、车载核销和替代线路的票务记录处理接驳。 这些上游资料可通过本地合成接口查阅。站点分承运方定义，换班后设备流水从一位开始计数。无需访问真实票务系统。

## 运行来源服务

使用 Node.js 22。运行 `npm ci --offline --ignore-scripts --no-audit` 校验锁文件，`npm run source` 启动服务。默认监听 `127.0.0.1:4173`，可用 `SOURCE_PORT` 更换端口。运行 `npm test` 检查来源发布内容、传输格式、领域规则和端到端台账。服务重启会清空临时门户请求。

## 夜班台账（本项目）

`src/` 是接入合成来源的客服侧系统，只用合成乘客代号（T1/T2/T3），不存人名：

| 模块 | 职责 |
| --- | --- |
| `src/source-client.mjs` | 三阶段 GET 取数、503 重试、门户 book/release/inspect 的幂等提交（同 key 同报文回原回执，异报文 409 上抛） |
| `src/stations.mjs` | 站点按运营方+站点编号+生效时段区分；封闭通知覆盖同范围一般开放声明；同名站互不影响 |
| `src/evidence.mjs` | 车载流水以 `operator/device/run/seq` 为唯一身份（换班 seq 复用不冲突）；票号以 `operator/issue/ticket` 定位，跨承运人重号不合并；整卷更正留痕；缺卷显式标记 |
| `src/desk.mjs` | 替代线路席位台账：意向、占位、门户确认、释放待查、人工挂起；共享座位不得同时承诺给两个家庭 |
| `src/engine.mjs` | 把团单、公告、流水、交接范围、连接规则、门户回执串成乘客级对账与补位操作 |
| `src/store.mjs` | JSONL 事件存储，交班后重放还原台账，释放时间与依据可审计 |
| `src/cli.mjs` | 夜班操作入口与端到端 `demo` |

### 规则如何落地

- **不靠人名、不把整团二段票当已坐**：所有结论按乘客代号逐票核对；团单只用于登记票号与交接范围，同团其他人的实乘不会互相推断。
- **交接范围以 handover 签发为准**：只有 `issue + travellers` 命中的子单乘客才进入对应替代范围；T3 属另一 issue，即使票号同为 B-8 也不并入。
- **迟到离线流水按实际核销时间解释**：`b-late` 到达晚，但扫描时间 07:50/07:58 才是业务时刻；`a-ledger` 重新发布视为整卷更正，旧的 X-A 核销被 X-ALT 取代并留痕。
- **缺卷与空卷区分**：声明了却取不到的卷标 `missing`，结论保持“不确定”；交付了空卷但运营方已有带行卷在记账时，无核销才能判“确认未乘/错过转乘”。
- **无法关联的流水只登记不猜人**：`unlinkedScans` 暴露票号不在团单内的流水，绝不按团号或姓名挂靠。
- **改道公告不等于留座**：公告只改“该去哪等”；替代车座位必须等门户 book 回执确认才算占住。
- **不重复收费**：每次补位用稳定请求 key（乘客+替代车+决策时刻），503 后只允许 inspect 找回执，禁止换 key 重发；本地先占座、门户失败回滚。
- **已确认补位后来查到原二段已乘**：未过 `expires` 走门户 release（回执 pending 时冻结座位，inspect 到 released 才放回）；过了发车时刻转人工挂起，座位不得再售。
- **仍在路上的人**：第一段实乘未补齐时只显示交接的换乘点，转乘权益挂起，不出补位承诺。

## CLI 用法

先启动来源服务（另开终端 `npm run source`），然后：

```bash
npm run demo                 # 三阶段端到端演示，临时台账跑完即弃
node src/cli.mjs ingest --phase confirmed
node src/cli.mjs board                      # 交班视图：等候点、两段状态、是否真留座
node src/cli.mjs passenger --code T1 --json # 单乘客完整证据链
node src/cli.mjs book --code T2 --trip ALT9 --at 08:05
node src/cli.mjs conflict --code T1 --at 08:10   # 原二段查到已乘后的撤下分流
node src/cli.mjs follow --code T1 --key <releaseKey> --at 08:11
node src/cli.mjs audit --code T1                 # 何时、凭什么释放
```

`--dir` 指定台账目录（默认 `./.desk-data`，已在 `.gitignore`）；`SOURCE_URL` 覆盖来源地址；`--now` 覆盖业务时钟。下次接入新团单时，对同一引擎重新 `ingestPhase` 并沿用事件台账即可。

## 来源协议（上游）

GET `/v1/{release}/{resource}` 读取资源。阶段名为 `opening`、`interim`、`confirmed`，分别是开始时、中间观察和后续发布。阶段名只用于选择模拟接口，使用资料中标注的编号与有效时间判断其业务含义。返回的 `X-Release` 指观察阶段。索引声明的页暂未发布时返回 404，服务暂不可用时返回 503。各发布方的业务编号及生效信息见资源正文。

日期均为 2026-12-04，时区 UTC+08:00。封闭通知按运营方、站点编号、起止时间覆盖同范围的一般开放声明。票号需联合运营方及 issue。设备流水在 operator、device、run、seq 联合身份中唯一。handover 明确子单乘客及运营方确认的上落站对应关系，原第二段的实乘以车载实际核销为准。connections 的 grace_minutes 是发车后仍可核销的分钟，allow_replace 适用于实际错过连接的人。替代线路席位在 expires 之前可由门户确认撤下，发车后需人工。portal 支持 book、release、inspect。

这些接口固定提供以下资源。分页资源名以各业务索引为准。

`bookings`, `station-index`, `roads-one`, `scans-index`, `a-ledger`, `b-ledger`, `handover`, `replacement`, `confirmations`, `connections`

POST `/v1/{release}/portal` 接受 JSON 对象，`action` 取操作名，`key` 是来件唯一请求号，`facts` 可携带操作的业务事实。首次接收通常返回 201，发出完全相同的报文按原请求返回 200，已有请求号换报文返回 409。用 `inspect` 和原 `key` 查询，可见回执时返回 200。无法查到记录返回 404。正常接收的回执含 `sourceRef`，业务状态字段随来源使用 `result`。合成门户保留请求并提供回执查询。

`wire/` 保存发布方的原始载荷，`wire.json` 记录各阶段可访问的路由，便于人工对照接口。

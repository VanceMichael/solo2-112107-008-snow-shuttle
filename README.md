# 雪场联运接驳的实乘证据与过站补救

民宿夜班客服用团单、运营方公告、车载核销和替代线路的票务记录处理接驳。 这些上游资料可通过本地合成接口查阅。站点分承运方定义，换班后设备流水从一位开始计数。无需访问真实票务系统。

## 运行来源服务

使用 Node.js 22。运行 `npm ci --offline --ignore-scripts --no-audit` 校验锁文件，`npm run source` 启动服务。默认监听 `127.0.0.1:4173`，可用 `SOURCE_PORT` 更换端口。运行 `npm test` 检查来源发布内容、传输格式和本地门户交互。服务重启会清空临时门户请求。

## 来源协议

GET `/v1/{release}/{resource}` 读取资源。阶段名为 `opening`、`interim`、`confirmed`，分别是开始时、中间观察和后续发布。阶段名只用于选择模拟接口，使用资料中标注的编号与有效时间判断其业务含义。返回的 `X-Release` 指观察阶段。索引声明的页暂未发布时返回 404，服务暂不可用时返回 503。各发布方的业务编号及生效信息见资源正文。

日期均为 2026-12-04，时区 UTC+08:00。封闭通知按运营方、站点编号、起止时间覆盖同范围的一般开放声明。票号需联合运营方及 issue。设备流水在 operator、device、run、seq 联合身份中唯一。handover 明确子单乘客及运营方确认的上落站对应关系，原第二段的实乘以车载实际核销为准。connections 的 grace_minutes 是发车后仍可核销的分钟，allow_replace 适用于实际错过连接的人。替代线路席位在 expires 之前可由门户确认撤下，发车后需人工。portal 支持 book、release、inspect。

这些接口固定提供以下资源。分页资源名以各业务索引为准。

`bookings`, `station-index`, `roads-one`, `scans-index`, `a-ledger`, `b-ledger`, `handover`, `replacement`, `confirmations`, `connections`

POST `/v1/{release}/portal` 接受 JSON 对象，`action` 取操作名，`key` 是来件唯一请求号，`facts` 可携带操作的业务事实。首次接收通常返回 201，发出完全相同的报文按原请求返回 200，已有请求号换报文返回 409。用 `inspect` 和原 `key` 查询，可见回执时返回 200。无法查到记录返回 404。正常接收的回执含 `sourceRef`，业务状态字段随来源使用 `result`。合成门户保留请求并提供回执查询。

`wire/` 保存发布方的原始载荷，`wire.json` 记录各阶段可访问的路由，便于人工对照接口。

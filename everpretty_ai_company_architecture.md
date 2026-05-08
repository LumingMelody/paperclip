# EverPretty AI 公司架构设计

> 面向"中国制造 + 全球多渠道 DTC + 季节性时尚"业态的 AI Agent 公司架构方案
> 编排框架:Paperclip(https://github.com/paperclipai/paperclip)
> 执行 Runtime:OpenClaw / Claude Code(可混用)

---

## 一、生意特性(架构设计的前置约束)

EverPretty 是女装轻礼服品牌,做这类生意的 AI 公司架构不能套通用模板,有 5 个特殊性必须先认清:

1. **SKU 爆炸**:款式 × 颜色 × 码数,轻礼服尤其严重
2. **季节性脉冲 + 长链路**:婚季、毕业舞会、节假日是脉冲式爆发,中国到海外仓 30~60 天,库存预测是命门
3. **高退货率 + 退货数据有巨大产品价值**:尺码、色差、剪裁反馈是金矿
4. **视觉驱动**:图片质量直接决定转化
5. **多市场偏好差异大**:美码 ≠ 欧码 ≠ 日码,审美也不一样

---

## 二、整体架构

### 顶层
- **CEO Agent**:跨部门决策、每日/每周 brief、跟用户汇报
- **战略 Agent**:季度规划、新市场进入、品类拓展

### 执行部门

#### A. 渠道运营中心(最大头)
- Amazon 美国 / 欧洲 / 日本 Agent(每个下设 listing、广告、补货子 Agent)
- 独立站 Agent(Shopify / 自建)
- B2B Agent(对接凯帝丽莎)
- 其他平台 Agent(Walmart、TEMU、SHEIN、eBay)

#### B. 商品中心
- 选品 Agent(Pinterest / 小红书 / TikTok 趋势 → 新款建议)
- 视觉 Agent(主图 / A+ / 详情页质检)
- ★ 评价分析 Agent(从评论里挖尺码、质量、色差反馈)

#### C. 供应链中心
- ★ 库存预测 Agent(销售 + 季节性 + 在途)
- 工厂协同 Agent(下单、跟单、QC)
- 物流 Agent(FBA 补货、头程、海外仓)

#### D. 营销中心
- 站外广告 Agent(Google / Meta / TikTok Ads)
- 内容 Agent(社媒、博客)
- 红人 Agent(KOL / KOC 触达)

#### E. 客户中心
- 客服 Agent(咨询,尤其是尺码问题)
- ★ 退货分析 Agent(给商品中心反哺)

#### F. 财务中心
- 利润核算 Agent(SKU / 渠道级)
- 现金流 / 汇率 Agent

### 共享基础设施(不是 Agent)
- **数据中台 / MCP Server**:统一封装所有外部 API,所有 Agent 都走这个口子
- **审批流**:大额或敏感决策走人审

---

## 三、三个 ★ 核心 Agent 的特殊地位

不是因为它们更重要,而是它们**横跨多个部门、一个 Agent 喂多个下游**,是反馈闭环的关键节点:

| Agent | 上游数据 | 下游受益方 |
|---|---|---|
| 评价分析 Agent | 各渠道评论 | 商品中心改款 + 客服知识库 + listing 优化 |
| 库存预测 Agent | 销售 + 季节性 | 工厂下单 + FBA 补货 + 现金流预测 |
| 退货分析 Agent | 各渠道退货数据 | 尺码表修订 + 产品设计 + listing 描述 |

这三个做出来,整个公司的"反馈闭环"就立起来了。

---

## 四、落地路径(必须按此顺序)

### Phase 0 — 基建(2~4 周):数据中台

把所有数据源封装成 MCP Server:Amazon SP-API、领星 ERP、凯帝丽莎、独立站、广告平台。

**关键原则:先只开"读"接口,写接口缓上。**

这步是脏活,但是地基。

### Phase 1 — MVP(4~6 周):验证一条完整链路

**推荐组合:Amazon 美国 Agent + 评价分析 Agent + 库存预测 Agent**

选这个组合的理由:
- 美国站通常是这类公司最大渠道,数据量大、立竿见影
- 评价分析 → Amazon Agent 优化 listing → 马上看到转化率变化
- 库存预测 → 补货决策 → 马上看到断货率 / 周转改善

**这阶段千万别上 CEO Agent。下面没东西可管的时候,CEO Agent 就是个聊天机器人。**

### Phase 2 — 横向复制(2~3 个月)
- 复制到 Amazon EU / JP(代码大量复用)
- 加独立站 Agent、B2B Agent
- 上供应链中心(工厂协同、物流)

### Phase 3 — 全栈 + 治理
- 上营销、客户中心
- **这时候才上 CEO Agent + Paperclip 做正式编排**,因为终于有真实数据可以汇总
- 加预算治理、审批流

---

## 五、这类生意特有的 5 个坑

1. **图片必须当一等公民**
   轻礼服是视觉品类,MCP 工具要带图像理解能力。本地 Gemma 4 31B(M4 Max 128GB)正好可以处理图,省 API 费 + 图不出公司。

2. **多市场尺码必须分库**
   美/欧/日/亚洲码完全不同,评价分析 Agent 必须按市场分别建反馈库,不能混。

3. **季节性预测别用简单时序模型**
   婚季、毕业季是脉冲,要结合 Google Trends、节日日历、去年同期同款一起预测。

4. **跨渠道价格协同**
   Amazon、独立站、B2B 价格打架会出大问题,需要一个跨渠道价格协调机制(可以做成单独 Agent,也可以放在 CEO 的 KPI 约束里)。

5. **合规自动检查**
   欧洲 GPSR、加州 Prop 65、日本 PSE,新品上架前可以让一个合规 Agent 自动走一遍。

---

## 六、数据接入(整个项目的真正大头)

### 为什么这是核心工作

Paperclip 解决的是"怎么调度",但调度的前提是 Agent 能看到数据、能动数据。**没数据接入,Agent 就是个只会写文档的空壳。**

举例:运营部 Agent "自动监控 Amazon 广告效果并调整出价",至少需要:
1. **读** Amazon 广告 API 拿到 ACOS、点击、转化数据
2. **读** 领星 ERP 拿到库存、利润数据(交叉验证)
3. **读** 凯帝丽莎 拿到 B2B 订单数据
4. **写** Amazon 广告 API 改出价
5. **写** 把决策日志回写到某个地方让 CEO Agent 能看到

Paperclip 帮你做的只有"让这个 Agent 每天定时跑一次"。剩下全是数据接入工作。

### 数据接入的三层

**第一层:能不能拿到(认证 + 网络)**
- API 权限申请(SHEIN、领星、Amazon SP-API 等)
- 国内服务器调海外 API 的代理路由(已有 Clash/711Proxy 方案)
- 各种 OAuth/API Key 的安全存储

**第二层:怎么给 Agent 用(协议层)**

| 方案 | 适合场景 | 缺点 |
|---|---|---|
| **MCP Server**(推荐) | 一次封装,Claude Code/OpenClaw/Cursor 都能用 | 要写 MCP 服务,初期投入大 |
| 直接函数调用 | 快,简单脚本就能跑 | 每个 Agent runtime 要重写一遍 |
| HTTP API + OpenAPI schema | 通用,Paperclip 的 HTTP agent 直接吃 | 需要 Agent 自己理解 schema |
| 写成 Skill | OpenClaw/Claude Code 都支持 skill | 跨 Agent 复用性一般 |

**结论:走 MCP Server 路线最划算**——写一次,所有 Agent 都能用,Paperclip 编排起来也干净。

**第三层:数据治理**
- **数据时效性**:Amazon 广告数据有 48 小时延迟,Agent 要知道"我现在看的是 2 天前的数据"
- **写操作的幂等性**:Agent 心跳重跑了一次,会不会把同一个出价改两遍
- **数据冲突**:两个部门 Agent 同时读凯帝丽莎,看到的库存对得上吗
- **审计**:哪个 Agent 在什么时间改了什么,出了问题能不能回滚

### 数据接入的实操原则

1. **先挑一个数据闭环最完整的部门做 MVP**(推荐 Amazon 运营部)
2. **第一版只做"读 + 汇报",不做"写"**——让 Agent 每天读数据生成日报,先建立信任
3. **写一个统一的 MCP Server 把多个数据源包起来**,Agent 调用都走这个口子,日志、限流、错误处理统一管
4. **写权限边界在 MCP Server 层**:运营 Agent 不能动财务数据,财务 Agent 不能改 listing。靠 prompt 约束不可靠,靠代码层强制
5. **最后才接"写"操作**,而且加二次确认——金额超过阈值、影响范围超过阈值的,必须人工 approve

---

## 七、已有资产复用清单

| 已有资产 | 用到哪里 |
|---|---|
| 凯帝丽莎 | B2B Agent 的核心数据源 |
| 领星 ERP | 跨渠道库存 + 利润数据,几乎所有部门都要用 |
| OpenClaw + Claude Code | 各部门 Agent 的执行 runtime |
| 本地 Gemma 4 31B(M4 Max) | 视觉 Agent、评价分析(海量评论用本地模型省钱) |
| Tencent Cloud / MySQL | 数据中台落库 |
| 711Proxy / Clash | 跨境 API 调用走代理 |
| RTK(Rust Token Killer) | 控制 Agent token 消耗 |
| Paperclip | 顶层编排框架 |

**核心结论:基本上不需要新加基础设施。真正的工作量在"把这些资产用 MCP Server 串成一个统一接口层"。这件事做完,后面每加一个部门 Agent 都是几天的事。**

---

## 八、给 Claude Code 的执行任务清单

以下任务建议按顺序执行,每完成一项再进入下一项。

### 任务 0:仓库初始化
- [ ] 建立 monorepo 结构:`mcp-servers/`、`agents/`、`paperclip-config/`、`docs/`
- [ ] 配置 pnpm workspace
- [ ] 配置 .env.example,列出所有需要的 API Key 占位符
- [ ] 配置 git hooks 防止 .env 泄露
- [ ] 建立基础的日志、错误监控、限流中间件

### 任务 1:数据中台 - MCP Server 第一批(读接口)
建议优先级顺序:

- [ ] **MCP-AmazonSPAPI**:封装 Amazon SP-API,提供 `get_orders`、`get_listings`、`get_inventory`、`get_ad_metrics` 等只读工具
- [ ] **MCP-LingxingERP**:封装领星 ERP,提供跨渠道库存、利润、订单查询
- [ ] **MCP-Kaidilisha**(凯帝丽莎):封装 B2B 业务数据查询
- [ ] **MCP-Reviews**:统一各渠道评论拉取(Amazon、独立站等)

**每个 MCP Server 必须满足**:
1. 所有工具走代理(读环境变量配置 SOCKS5/HTTP 代理)
2. 统一的错误格式 + 重试策略
3. 输出格式统一(参考已有的 reviews 数据结构)
4. 每次调用记审计日志(谁调的、什么时候、参数、结果摘要)
5. 速率限制 + token 预算上限

### 任务 2:第一个部门 Agent(只读 MVP)

- [ ] **评价分析 Agent**:每天定时拉取 Amazon US 全部 SKU 评论,用本地 Gemma 4 31B 提取尺码/色差/质量反馈,输出结构化报告(JSON)
- [ ] **报告归档**:写到 MySQL,带按 SKU、按市场、按时间的查询接口
- [ ] **每日 brief**:生成 Markdown 日报推送到企微/飞书

### 任务 3:第二个部门 Agent

- [ ] **库存预测 Agent**:基于销售历史 + 季节性日历 + 在途库存,输出未来 30/60/90 天补货建议
- [ ] **暂时只做建议,不直接下单**

### 任务 4:第三个部门 Agent + 闭环

- [ ] **Amazon 美国运营 Agent**:消费评价分析 Agent 的输出,生成 listing 优化建议(标题、bullet points、A+ 内容)
- [ ] **第一阶段:建议输出到飞书文档,人工审核后手动发布**
- [ ] 跑两周,看转化率/CTR 变化

### 任务 5:Paperclip 编排接入

- [ ] 部署 Paperclip(`npx paperclipai onboard --yes`)
- [ ] 把上述 3 个 Agent 注册进去
- [ ] 配置 heartbeat 调度
- [ ] 配置每个 Agent 的月度 token 预算
- [ ] 暂不引入 CEO Agent

### 任务 6:写入接口 + 审批流(谨慎)

- [ ] 在 MCP Server 层加"写"接口,所有写操作必须经过审批流
- [ ] Paperclip 的 governance 配置审批门槛(金额、影响范围)
- [ ] 添加幂等性保护(同一个 Agent 心跳重跑不会重复执行)

### 任务 7:横向扩展

- [ ] 复制到 Amazon EU / JP
- [ ] 加独立站、B2B Agent
- [ ] 这时候才考虑引入 CEO Agent,做跨部门汇总和主动汇报

---

## 九、Claude Code 执行时的工程约束

> 这部分是 Claude Code 必须遵守的工程纪律,**不是建议,是要求**。

### 代码组织
- **Monorepo + pnpm workspace**:`mcp-servers/`、`agents/`、`shared/`、`paperclip-config/`
- **每个 MCP Server 独立 package**,有独立 README、test、CHANGELOG
- **共享逻辑放 `shared/`**:日志、代理配置、错误类型、审计日志写入

### 网络与代理
- 所有调用海外 API 的代码,**必须从环境变量读代理配置**,不能硬编码
- 代理地址:711Proxy SOCKS5 `global.sta.711proxy.com:30000`(开发环境)
- 国内 API(凯帝丽莎、领星)直连,不走代理

### 安全
- API Key 走 `.env` + 不入库,生产环境用密钥管理服务
- MCP Server 写接口必须有权限检查(哪个 Agent 能调哪个工具,在 Server 层强制)
- 所有写操作必须记审计日志

### 测试
- MCP Server 的每个工具至少要有一个 integration test(用 mock API)
- Agent 的核心逻辑要有 unit test
- 上写接口前必须有完整的端到端测试

### 模型与 Token 管控
- 海量数据处理(评价分析、视觉处理)优先用本地 Gemma 4 31B(MLX)
- 决策类、复杂推理用 Claude Code / OpenClaw
- 接入 RTK 做 token 压缩
- 每个 Agent 设月度预算,超了报警

### 文档
- 每个 MCP Server 必须有 README,说明:工具列表、参数、返回格式、限制
- 每个 Agent 必须有 prompt 文档 + 决策逻辑说明
- 关键架构决策写 ADR(Architecture Decision Record)

---

## 十、最重要的提醒

**很多人做"AI 公司"会先搭组织架构、设计 CEO 怎么管 CTO、CTO 怎么管工程师……结果折腾两周一个 Agent 都没真正干活。**

**正确顺序是反过来的**:
1. 先让一个 Agent 真正接好一个数据源、跑通一个闭环
2. 验证这条路是通的
3. 第二个、第三个
4. 等有 3~4 个能干活的部门 Agent 了,才上 Paperclip 做编排
5. 这时候 CEO Agent 才有东西可"管"

否则就是空中楼阁:CEO Agent 在那汇报,但底下没人真在干活。

---

## 附录:目录结构建议

```
everpretty-ai/
├── mcp-servers/
│   ├── amazon-spapi/
│   ├── lingxing-erp/
│   ├── kaidilisha/
│   ├── reviews/
│   └── shared/                # 共享:proxy、logger、auth、audit
├── agents/
│   ├── review-analyzer/       # ★ 评价分析 Agent
│   ├── inventory-forecaster/  # ★ 库存预测 Agent
│   ├── amazon-us-operator/
│   └── shared/                # Agent 通用逻辑
├── paperclip-config/
│   ├── company.yaml           # 公司架构定义
│   ├── agents/                # Agent 注册配置
│   └── budgets.yaml           # 预算配置
├── docs/
│   ├── adr/                   # 架构决策记录
│   ├── playbooks/             # 各部门 SOP
│   └── README.md
├── scripts/
│   ├── setup.sh
│   └── proxy-check.sh
├── .env.example
├── pnpm-workspace.yaml
└── package.json
```

# 远程天文台使用申请审批及统计系统

一个支持普通用户与管理员双角色、申请提交审批与统计分析的网页应用。

## 功能特性

### 用户与登录
- 普通用户 / 管理员 双角色，账号密码登录
- 普通用户可自助注册，管理员账号由系统预设
- 按角色渲染不同功能界面，权限严格隔离

### 普通用户端
- 提交观测申请：设备、使用时段（支持跨日夜间时段）、拍摄目标、拍摄目的、申请人信息
- 提交时实时冲突检测，同设备时段重叠会提示并阻止提交
- 状态实时展示：待审批 → 已通过 / 未通过 / 已撤回
- 待审批状态可自行撤回
- 我的申请列表 + 完整状态变更历史时间线

### 管理员端
- 待审批列表（按提交时间升序）
- 同意 / 不同意 审批，不同意必须填写审批意见
- 审批时自动冲突检测，确认后可强制通过
- 设备时段占用日历视图（已通过绿色 / 待审批黄色）
- 全部申请列表（状态筛选、关键词搜索、分页）
- 操作审计日志

### 统计分析
- 状态数量统计 + 通过率
- 饼图（状态分布）、柱状图（各设备申请量）、折线图（月度趋势）
- 一键导出 CSV 统计报表

## 技术栈
- 后端：Node.js + Express + SQLite（Node 内置 node:sqlite，零原生依赖）
- 前端：Vue 3（本地化 CDN）+ Chart.js
- 认证：Session + scrypt 密码哈希（带盐、常量时间比较）
- 安全：参数化查询防 SQL 注入、认证接口限速、防会话固定、CSV 公式注入防护

## 快速开始

    cd remote-observatory
    npm install --cache ./.npm-cache
    npm start

启动后浏览器访问 http://localhost:3000

## 环境变量（生产部署必读）

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| PORT | 监听端口 | 3000 |
| SESSION_SECRET | 会话签名密钥，生产必须设置（可用 openssl rand -hex 32 生成） | 未设置时每次启动随机生成（重启后会话失效） |
| ADMIN_PASSWORD | 管理员密码，设置后每次启动会同步为该值 | admin123 |
| COOKIE_SECURE | 设为 true 后 cookie 仅经 HTTPS 传输 | false |
| COOKIE_SAMESITE | 同站策略，可设 lax / strict | lax |

示例：

    SESSION_SECRET=$(openssl rand -hex 32) ADMIN_PASSWORD=你的强密码 npm start

## 演示账号
- 管理员：admin / admin123（若设置了 ADMIN_PASSWORD 环境变量，则以该值为准）
- 普通用户：可自助注册，或使用已内置的 alice / 123456

## 项目结构

    remote-observatory/
    ├── server.js        # 后端入口与全部路由
    ├── db.js            # 数据库初始化与种子数据
    ├── package.json
    ├── data/            # SQLite 数据库文件（运行时生成）
    └── public/
        ├── index.html   # 单页应用
        ├── css/style.css
        ├── js/app.js    # Vue 前端逻辑
        └── vendor/      # 本地化的 Vue / Chart.js

## 数据重置

删除 data/observatory.db 后重启服务即可恢复全新环境（会自动重建管理员账号，密码取 ADMIN_PASSWORD 或默认 admin123）。

## 主要 API

- POST /api/auth/register / login / logout
- GET  /api/auth/me
- POST /api/applications   （提交申请，含冲突检测）
- GET  /api/applications/mine / :id
- POST /api/applications/:id/withdraw
- GET  /api/applications/conflicts   （时段冲突预检）
- GET  /api/admin/pending / calendar / stats / audit
- GET  /api/admin/applications   （筛选 / 搜索 / 分页）
- POST /api/admin/applications/:id/review
- GET  /api/admin/export.csv

# 从上游版本迁移到本维护版

已在运行上游 `weishaw/claude-relay-service` 的用户，切到本仓库镜像
`ghcr.io/sunseekerx/claude-relay-service`。数据（账户、API Key、统计）全部保留。

## 唯一注意事项

**不要动 `JWT_SECRET` 和 `ENCRYPTION_KEY`。** 这两个密钥决定 Redis 里的账户凭据能否解开，
换掉等于所有账户授权失效。别重跑 `crs-compose.sh` 之类的生成脚本（它会生成新密钥）。

版本号从 `1.1.x` 变成 `2.x`，只是为了跟上游区分，不是破坏性变更。

## Docker 部署

```bash
cd <你的部署目录>

# 1. 备份（密钥可能在 compose 也可能在 .env，都备上）
docker compose exec redis redis-cli BGSAVE && sleep 5
docker compose stop
mkdir -p ../crs-backup && cp -a redis_data data docker-compose.yml .env ../crs-backup/ 2>/dev/null

# 2. 改镜像（整行替换，连 tag 一起换 —— 本仓库没有 1.1.x 那些 tag）
sed -i -E 's|^(\s*)image:\s*\S*claude-relay-service(:\S+)?\s*$|\1image: ghcr.io/sunseekerx/claude-relay-service:latest|' docker-compose.yml
sed -i 's|^\(\s*\)build: \.|\1# build: .|' docker-compose.yml

# 3. 拉取启动
docker compose pull && docker compose up -d
docker compose logs -f --tail=50 claude-relay
```

日志里看到 `数据迁移完成，版本: 2.x.x` 和 `Application initialized successfully` 就好了。
首次启动会重建索引、回填历史费用，可能要几十秒。

然后打开管理界面登录一次，账户列表能正常显示就说明成了。

## 源码部署

```bash
cd <你的项目目录>
cp .env ../env-backup                                    # 含密钥
git remote set-url origin https://github.com/SunSeekerX/claude-relay-service.git
git fetch origin && git checkout main && git reset --hard origin/main
npm install && npm run install:web && npm run build:web
npm run service:restart:daemon
```

`.env` 不要覆盖，密钥沿用原值。

## 回滚

改回原来的镜像地址重启即可，数据没被破坏性修改：

```bash
cd <你的部署目录>
# 把 image 改回你迁移前用的那个（去 ../crs-backup/docker-compose.yml 里看原值）
grep image: ../crs-backup/docker-compose.yml
vi docker-compose.yml
docker compose up -d
```

要连数据一起退回迁移前，用备份覆盖 `redis_data`、`data`、`docker-compose.yml`（和 `.env`）再启动。
compose 和 redis_data 必须成套还原，不能混用不同批次的密钥和数据。

## 本版本的差异

- 模型定价数据源可在后台配置（设置 → 模型定价），填自定义地址点「拉取最新价格」即时生效
- 模型目录导入：把定价源里有、`/v1/models` 还没暴露的模型加进列表
- 镜像发到 GHCR，版本号自 `2.0.0` 起独立编号

## 常见问题

**账户列表空了 / 报解密错误** — `ENCRYPTION_KEY` 变了。从备份的 compose 或 `.env` 里取回原值。

**pull 报 manifest unknown** — tag 不存在。本仓库没有 `1.1.x`，确认 image 行是 `:latest`
或 [Releases](https://github.com/SunSeekerX/claude-relay-service/releases) 里真实存在的版本。

**日志有 404 / 400 / `Stream error: canceled`** — 上游账户侧的业务错误和客户端主动断连，
跟迁移无关。

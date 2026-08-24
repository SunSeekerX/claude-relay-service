# 从上游版本迁移到本维护版

本文档面向**已经在运行上游 `Wei-Shaw/claude-relay-service`**（镜像 `weishaw/claude-relay-service`）
的用户，说明如何切换到本仓库维护的版本（镜像 `ghcr.io/sunseekerx/claude-relay-service`）。

已有数据（账户、API Key、用量统计）全部保留，无需重新配置。

## 迁移前须知

**只要不改动 `JWT_SECRET` 和 `ENCRYPTION_KEY`，你的数据就能原样使用。**

这两个密钥决定了 Redis 里加密数据（OAuth token、账户凭据）能否解开。迁移过程中
绝对不要重新生成它们 —— 换掉等于丢失所有账户授权。

### 先确认你的密钥存在哪

有两种部署形态，备份时要备的文件不同。先查一下：

```bash
cd <你的部署目录>          # 含 docker-compose.yml 的目录
grep -E 'JWT_SECRET|ENCRYPTION_KEY' docker-compose.yml
```

- 输出形如 `- JWT_SECRET=k1X3U0...`（**字面值**）→ 密钥在 `docker-compose.yml` 里
  （`crs-compose.sh` 脚本生成的就是这种）
- 输出形如 `- JWT_SECRET=${JWT_SECRET}`（**变量引用**）→ 密钥在同目录的 `.env` 里，
  用 `grep -E 'JWT_SECRET|ENCRYPTION_KEY' .env` 确认

下面的备份步骤两种都覆盖，照做即可。

版本号从上游的 `1.1.x` 变为 `2.x`。这是为了与上游区分、避免版本号撞车，
不代表有破坏性变更。

## Docker Compose 部署

### 第一步：备份

停机前先让 Redis 落盘，再拷数据。直接拷运行中的文件可能拿到写一半的状态。

```bash
cd <你的部署目录>          # 含 docker-compose.yml 的目录

# 1. Redis 落盘（容器名按 docker compose ps 实际显示调整）
docker compose exec redis redis-cli BGSAVE
sleep 5

# 2. 停止服务
docker compose stop

# 3. 备份数据与配置
BACKUP="../crs-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp -a redis_data "$BACKUP/"
cp -a data "$BACKUP/"
cp -a docker-compose.yml "$BACKUP/"
[ -f .env ] && cp -a .env "$BACKUP/"          # 密钥可能在这里，存在就备
[ -f config/config.js ] && cp -a config/config.js "$BACKUP/"
echo "备份完成：$BACKUP"
ls -la "$BACKUP"
```

**承载密钥的文件必须备份**（`docker-compose.yml` 与 `.env` 之一，看上面查到的形态）。
丢了它，即使 `redis_data` 还在也解不开数据。

备份后自查一次，确认密钥真的备到了：

```bash
grep -hoE '(JWT_SECRET|ENCRYPTION_KEY)=.{4}' "$BACKUP"/docker-compose.yml "$BACKUP"/.env 2>/dev/null
```

应看到两个 key 各带一段非空值（形如 `JWT_SECRET=k1X3`）。
若只看到 `JWT_SECRET=${JW` 这种变量引用、且没有 `.env` 那一行，说明密钥没备到，
**先停下来**找到 `.env` 或你当初记录密钥的地方。

### 第二步：改镜像地址

先看一眼当前用的镜像：

```bash
grep -nE '^\s*image:.*claude-relay-service' docker-compose.yml
```

```bash
# 注释掉 build（拉镜像部署时它是干扰项，避免误触发本地构建）
sed -i 's|^\(\s*\)build: \.|\1# build: .|' docker-compose.yml

# 换成本仓库镜像。整行替换（连 tag 一起换），不是只换仓库前缀 ——
# 上游若 pin 了版本（如 :v1.1.314），只换前缀会得到
# ghcr.io/sunseekerx/claude-relay-service:v1.1.314，而本仓库的版本号自 2.0.0 起
# 独立编号、不存在 1.1.x 这些 tag，pull 会直接失败
sed -i -E 's|^(\s*)image:\s*\S*claude-relay-service(:\S+)?\s*$|\1image: ghcr.io/sunseekerx/claude-relay-service:latest|' docker-compose.yml
```

想固定到具体版本而不用 `latest`，把上面命令里的 `:latest` 换成
[Releases](https://github.com/SunSeekerX/claude-relay-service/releases) 里的版本号
（如 `:v2.0.2`）。可用 tag 也能直接查：

```bash
curl -s "https://ghcr.io/v2/sunseekerx/claude-relay-service/tags/list" \
  -H "Authorization: Bearer $(curl -s 'https://ghcr.io/token?scope=repository:sunseekerx/claude-relay-service:pull&service=ghcr.io' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
```

改完确认一下，应该只有 image 与 build 两行变化（把路径换成上一步实际生成的备份目录）：

```bash
diff ../crs-backup-*/docker-compose.yml docker-compose.yml
```

预期输出（`<` 是原值，`>` 是改后）：

```diff
<     build: .
<     image: weishaw/claude-relay-service:latest
---
>     # build: .
>     image: ghcr.io/sunseekerx/claude-relay-service:latest
```

如果还有别的差异，**先停下来**。尤其是 `JWT_SECRET` / `ENCRYPTION_KEY` 那两行
出现在 diff 里 —— 密钥被改过就会导致数据解不开。

### 第三步：拉取并启动

```bash
docker compose pull
docker compose up -d
docker compose logs -f --tail=100 claude-relay      # 看完 Ctrl+C 退出
```

镜像同时提供 `linux/amd64` 与 `linux/arm64`，无需指定架构。

### 第四步：验证

启动日志里应看到迁移正常完成：

```
🔄 检测到新版本 2.x.x，检查数据迁移...
✅ 数据迁移完成，版本: 2.x.x
✅ Application initialized successfully
```

首次启动会重建索引、回填历史费用，视数据量可能耗时数十秒，属正常。

再确认三项：

```bash
# 1. 版本与健康状态
curl -s http://127.0.0.1:3000/health

# 2. 数据还在（key 数应与迁移前大致相当）
docker compose exec redis redis-cli DBSIZE

# 3. 无解密失败告警
docker compose logs --tail=300 claude-relay | grep -i "解密失败\|decrypt.*fail"
```

最后**打开管理界面登录一次，看账户列表能否正常显示** —— 这是最可靠的判据，
说明 `ENCRYPTION_KEY` 解密链路是通的。

## 源码部署

```bash
cd <你的项目目录>

# 1. 备份配置（.env 含密钥，务必备份）
BACKUP="../crs-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp -a .env "$BACKUP/"
cp -a data "$BACKUP/"
[ -f config/config.js ] && cp -a config/config.js "$BACKUP/"

# 2. 换上游地址为本仓库
git remote set-url origin https://github.com/SunSeekerX/claude-relay-service.git
git fetch origin
git checkout main
git reset --hard origin/main               # 本地有改动请先自行保存

# 3. 依赖与前端
npm install
npm run install:web && npm run build:web

# 4. 重启
npm run service:restart:daemon
npm run service:status
```

`.env` 不要覆盖 —— 里面的 `JWT_SECRET` / `ENCRYPTION_KEY` 必须沿用原值。

## 回滚

数据在迁移过程中未被破坏性修改，把 image 行改回去即可回到上游版本。

**从备份里取回原始 image 行**，不要用字符串替换去猜 —— 上游与本仓库的版本号互不相通
（本仓库没有 `1.1.x`，上游也没有 `2.x`），只换仓库前缀会拼出一个不存在的镜像。
备份里的那行才是你迁移前真实在用的版本：

```bash
cd <你的部署目录>
BACKUP=../crs-backup-20260824-094908        # 换成你实际的备份目录

# 看一眼备份里的原始 image 行
grep -nE '^\s*image:.*claude-relay-service' "$BACKUP/docker-compose.yml"

# 用它替换当前的 image 行（自动读取，不手抄）
OLD_IMAGE=$(grep -oE '^\s*image:.*claude-relay-service(:\S+)?\s*$' "$BACKUP/docker-compose.yml" | head -1 | sed -E 's|^\s*image:\s*||; s|\s*$||')
echo "将回滚到：${OLD_IMAGE}"
sed -i -E "s|^(\s*)image:\s*\S*claude-relay-service(:\S+)?\s*$|\1image: ${OLD_IMAGE}|" docker-compose.yml

# 迁移时注释掉的 build 一并恢复（若原来有）
grep -qE '^\s*build: \.' "$BACKUP/docker-compose.yml" && sed -i 's|^\(\s*\)# build: \.|\1build: .|' docker-compose.yml

# 确认改对了，再启动
diff "$BACKUP/docker-compose.yml" docker-compose.yml && echo "已与备份完全一致"
docker compose up -d
```

`diff` 无输出说明 compose 已还原到迁移前的状态。

若数据也想回到迁移前那一刻（例如新版本已经写入了你不想保留的数据），
用下面这套整目录还原 —— 它直接覆盖备份的 compose，不需要上面那些 image 行操作：

```bash
cd <你的部署目录>
docker compose down

BACKUP=../crs-backup-20260824-094908        # 换成你实际的备份目录
rm -rf redis_data data
cp -a "$BACKUP/redis_data" ./
cp -a "$BACKUP/data" ./
cp -a "$BACKUP/docker-compose.yml" ./
[ -f "$BACKUP/.env" ] && cp -a "$BACKUP/.env" ./      # 密钥在 .env 的部署必须一起还原

docker compose up -d
```

注意 `docker-compose.yml` 与 `redis_data` 必须**成套**还原 —— 不可混用不同批次的
密钥与数据，否则数据解不开。

## 本版本的主要差异

- **模型定价数据源可在管理后台配置**（设置 → 模型定价 → 模型定价数据源）。
  填入自定义 JSON 地址后点「拉取最新价格」即时生效，无需重启；留空走内置默认源。
  地址的路径与查询参数加密存储，不在日志和界面回显。
- **模型目录导入**（设置 → 模型定价 → 模型目录）。把定价源里有、但 `/v1/models`
  还没暴露的对话类模型加进列表。导入只影响模型列表的可见性，不改变转发能力
  （能否调用仍取决于账户的模型映射）。
- 镜像发布到 GHCR，版本号自 `2.0.0` 起独立编号。

## 常见问题

**管理界面能打开，但账户列表为空或报解密错误**

`ENCRYPTION_KEY` 与数据不匹配。按你的部署形态检查值是否与迁移前一致：

```bash
# 密钥写在 compose 里的
grep -E 'JWT_SECRET|ENCRYPTION_KEY' docker-compose.yml
# 密钥在 .env 里的
grep -E 'JWT_SECRET|ENCRYPTION_KEY' .env
```

最常见的原因是重新跑了 `crs-compose.sh` 之类的生成脚本，它会生成**新的**随机密钥
覆盖原值。从备份的配置文件里取回原值即可（改完 `docker compose up -d` 重启）。

**`docker compose pull` 报 manifest unknown / not found**

八成是 tag 不存在。本仓库版本号自 `2.0.0` 起独立编号，**没有 1.1.x 这些 tag** ——
如果你原来 pin 了上游版本（如 `:v1.1.314`）而替换时只换了仓库前缀，就会拉一个
不存在的镜像。确认 image 行是 `:latest` 或
[Releases](https://github.com/SunSeekerX/claude-relay-service/releases) 里真实存在的版本：

```bash
grep -nE '^\s*image:.*claude-relay-service' docker-compose.yml
```

另一种可能是地址拼写有误。仓库名全小写：
`ghcr.io/sunseekerx/claude-relay-service`。本镜像为公开包，无需登录 GHCR。

**启动日志有 404 / 400 / `Stream error: canceled`**

这些是上游账户侧的业务错误与客户端主动断开连接，不是迁移问题。
`canceled` 通常是客户端关闭了流式请求。

**版本号从 1.1.x 跳到 2.x，是不是不兼容**

不是。仅为与上游区分而独立编号，数据格式向后兼容，启动时的迁移会自动处理。

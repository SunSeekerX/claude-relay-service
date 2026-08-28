#!/bin/bash

# Claude Relay Service - 统一状态检查脚本
# 提供完整的系统状态概览

# 加载环境变量
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# 参数处理
DETAIL_MODE=false
if [ "$1" = "--detail" ] || [ "$1" = "-d" ]; then
    DETAIL_MODE=true
fi

echo "Claude Relay Service - 系统状态检查"
if [ "$DETAIL_MODE" = true ]; then
    echo "模式: 详细信息"
else
    echo "模式: 概览 (使用 --detail 查看详细信息)"
fi
echo "========================================"

# 获取服务配置
SERVICE_HOST=${HOST:-127.0.0.1}
SERVICE_PORT=${PORT:-3000}

if [ "$SERVICE_HOST" = "0.0.0.0" ]; then
    SERVICE_HOST="127.0.0.1"
fi

SERVICE_URL="http://${SERVICE_HOST}:${SERVICE_PORT}"

# 获取Redis配置
REDIS_HOST=${REDIS_HOST:-127.0.0.1}
REDIS_PORT=${REDIS_PORT:-6379}
REDIS_CMD="redis-cli -h $REDIS_HOST -p $REDIS_PORT"

if [ ! -z "$REDIS_PASSWORD" ]; then
    REDIS_CMD="redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD"
fi

# 检查Redis连接
echo "连接检查："
if $REDIS_CMD ping > /dev/null 2>&1; then
    echo "  Redis连接正常 ($REDIS_HOST:$REDIS_PORT)"
else
    echo "  Redis连接失败 ($REDIS_HOST:$REDIS_PORT)"
    exit 1
fi

# 检查服务状态
if command -v curl > /dev/null 2>&1; then
    health_response=$(curl -s ${SERVICE_URL}/health 2>/dev/null)
    if [ $? -eq 0 ]; then
        health_status=$(echo "$health_response" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 | head -1)
        if [ "$health_status" = "healthy" ]; then
            echo "  服务状态正常 ($SERVICE_URL)"
        else
            echo "  服务状态异常: $health_status ($SERVICE_URL)"
        fi
    else
        echo "  服务无法访问 ($SERVICE_URL)"
    fi
else
    echo "  curl命令不可用，无法检查服务状态"
fi

echo ""

# 格式化数字函数
format_number() {
    local num=$1
    if [ "$num" -ge 1000000 ]; then
        echo "$(echo "scale=1; $num / 1000000" | bc 2>/dev/null)M"
    elif [ "$num" -ge 1000 ]; then
        echo "$(echo "scale=1; $num / 1000" | bc 2>/dev/null)K"
    else
        echo "$num"
    fi
}

# 系统信息
echo "系统信息："

# Redis信息
redis_info=$($REDIS_CMD info server 2>/dev/null)
redis_memory_info=$($REDIS_CMD info memory 2>/dev/null)

redis_version=$(echo "$redis_info" | grep redis_version | cut -d: -f2 | tr -d '\r' 2>/dev/null)
redis_uptime=$(echo "$redis_info" | grep uptime_in_seconds | cut -d: -f2 | tr -d '\r' 2>/dev/null)
used_memory=$(echo "$redis_memory_info" | grep used_memory_human | cut -d: -f2 | tr -d '\r' 2>/dev/null)

if [ ! -z "$redis_version" ]; then
    echo "  Redis版本: $redis_version"
fi

if [ ! -z "$redis_uptime" ]; then
    uptime_hours=$((redis_uptime / 3600))
    echo "  Redis运行时间: $uptime_hours 小时"
fi

if [ ! -z "$used_memory" ]; then
    echo "  Redis内存使用: $used_memory"
fi

# 服务信息
if command -v curl > /dev/null 2>&1; then
    health_response=$(curl -s ${SERVICE_URL}/health 2>/dev/null)
    if [ $? -eq 0 ]; then
        uptime=$(echo "$health_response" | grep -o '"uptime":[^,}]*' | cut -d: -f2 | head -1)

        if [ ! -z "$uptime" ] && [ "$uptime" != "null" ]; then
            uptime_hours=$(echo "scale=1; $uptime / 3600" | bc 2>/dev/null)
            if [ ! -z "$uptime_hours" ]; then
                echo "  服务运行时间: $uptime_hours 小时"
            fi
        fi

        # 检查端口
        if netstat -ln 2>/dev/null | grep -q ":${SERVICE_PORT} "; then
            echo "  端口${SERVICE_PORT}: 正在监听"
        else
            echo "  端口${SERVICE_PORT}: 未监听"
        fi
    fi
fi

echo ""

# 并发状态
echo "并发状态："
concurrency_keys=$($REDIS_CMD --scan --pattern "concurrency:*" 2>/dev/null)

if [ -z "$concurrency_keys" ]; then
    echo "  当前无活跃并发连接"
else
    total_concurrent=0
    active_keys=0

    for key in $concurrency_keys; do
        count=$($REDIS_CMD get "$key" 2>/dev/null)
        if [ ! -z "$count" ] && [ "$count" -gt 0 ]; then
            api_key_id=${key#concurrency:}

            if [ "$DETAIL_MODE" = true ]; then
                api_key_name=$($REDIS_CMD hget "apikey:$api_key_id" name 2>/dev/null)
                concurrency_limit=$($REDIS_CMD hget "apikey:$api_key_id" concurrencyLimit 2>/dev/null)

                if [ -z "$api_key_name" ]; then
                    api_key_name="Unknown"
                fi

                if [ -z "$concurrency_limit" ] || [ "$concurrency_limit" = "0" ]; then
                    limit_text="无限制"
                else
                    limit_text="$concurrency_limit"
                fi

                echo "  $api_key_name: $count 个并发 (限制: $limit_text)"
            fi

            total_concurrent=$((total_concurrent + count))
            active_keys=$((active_keys + 1))
        fi
    done

    echo "  总计: $total_concurrent 个活跃并发连接 ($active_keys 个API Key)"
fi

echo ""

# 资源统计
echo "资源统计："

total_keys=$($REDIS_CMD keys "apikey:*" 2>/dev/null | grep -v "apikey:hash_map" | wc -l)
total_accounts=$($REDIS_CMD keys "claude:account:*" 2>/dev/null | wc -l)

echo "  API Key总数: $total_keys"
echo "  Claude账户数: $total_accounts"

# 详细模式下的使用统计
if [ "$DETAIL_MODE" = true ]; then
    echo ""
    echo "使用统计："

    today=$(date '+%Y-%m-%d')
    current_month=$(date '+%Y-%m')

    # 系统总体统计
    total_daily_requests=0
    total_daily_tokens=0
    total_requests=0
    total_tokens=0

    api_keys=$($REDIS_CMD keys "apikey:*" 2>/dev/null | grep -v "apikey:hash_map")

    if [ ! -z "$api_keys" ]; then
        echo "  API Key详情："

        for key in $api_keys; do
            api_key_id=${key#apikey:}

            # API Key基本信息
            api_key_name=$($REDIS_CMD hget "apikey:$api_key_id" name 2>/dev/null)
            token_limit=$($REDIS_CMD hget "apikey:$api_key_id" tokenLimit 2>/dev/null)
            created_at=$($REDIS_CMD hget "apikey:$api_key_id" createdAt 2>/dev/null)

            # 使用统计
            key_total_requests=$($REDIS_CMD hget "usage:$api_key_id" totalRequests 2>/dev/null)
            key_total_tokens=$($REDIS_CMD hget "usage:$api_key_id" totalTokens 2>/dev/null)
            key_daily_requests=$($REDIS_CMD hget "usage:daily:$api_key_id:$today" requests 2>/dev/null)
            key_daily_tokens=$($REDIS_CMD hget "usage:daily:$api_key_id:$today" tokens 2>/dev/null)

            # 默认值处理
            api_key_name=${api_key_name:-"Unknown"}
            token_limit=${token_limit:-0}
            key_total_requests=${key_total_requests:-0}
            key_total_tokens=${key_total_tokens:-0}
            key_daily_requests=${key_daily_requests:-0}
            key_daily_tokens=${key_daily_tokens:-0}

            # 格式化Token限制
            if [ "$token_limit" = "0" ]; then
                limit_text="无限制"
            else
                limit_text=$(format_number $token_limit)
            fi

            # 创建时间格式化
            if [ ! -z "$created_at" ]; then
                created_date=$(echo "$created_at" | cut -d'T' -f1)
            else
                created_date="未知"
            fi

            echo "    • $api_key_name (创建: $created_date, 限制: $limit_text)"
            echo "      今日: ${key_daily_requests}请求 / $(format_number $key_daily_tokens)tokens"
            echo "      总计: ${key_total_requests}请求 / $(format_number $key_total_tokens)tokens"
            echo ""

            # 累计统计
            total_daily_requests=$((total_daily_requests + key_daily_requests))
            total_daily_tokens=$((total_daily_tokens + key_daily_tokens))
            total_requests=$((total_requests + key_total_requests))
            total_tokens=$((total_tokens + key_total_tokens))
        done
    fi

    echo "  系统总计:"
    echo "    今日: ${total_daily_requests}请求 / $(format_number $total_daily_tokens)tokens"
    echo "    总计: ${total_requests}请求 / $(format_number $total_tokens)tokens"
fi

echo ""
echo "状态检查完成 - $(date '+%Y-%m-%d %H:%M:%S')"

if [ "$DETAIL_MODE" = false ]; then
    echo ""
    echo "使用 'npm run status -- --detail' 查看详细信息"
fi

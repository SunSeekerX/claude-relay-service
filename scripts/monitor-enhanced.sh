#!/bin/bash

# Claude Relay Service - 增强版实时监控脚本
# 结合并发监控和系统状态的完整监控方案

# 加载环境变量
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

echo "Claude Relay Service - 增强版实时监控"
echo "按 Ctrl+C 退出 | 按 's' 切换详细/简单模式"
echo "========================================"

# 获取服务配置
SERVICE_HOST=${HOST:-127.0.0.1}
SERVICE_PORT=${PORT:-3000}

# 如果HOST是0.0.0.0，客户端应该连接localhost
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
if ! $REDIS_CMD ping > /dev/null 2>&1; then
    echo "Redis连接失败，请检查Redis服务是否运行"
    echo "   配置: $REDIS_HOST:$REDIS_PORT"
    exit 1
fi

# 显示模式: simple(简单) / detailed(详细)
DISPLAY_MODE="simple"

# 获取API Key详细信息
get_api_key_info() {
    local api_key_id=$1
    local api_key_name=$($REDIS_CMD hget "apikey:$api_key_id" name 2>/dev/null)
    local concurrency_limit=$($REDIS_CMD hget "apikey:$api_key_id" concurrencyLimit 2>/dev/null)
    local token_limit=$($REDIS_CMD hget "apikey:$api_key_id" tokenLimit 2>/dev/null)
    local created_at=$($REDIS_CMD hget "apikey:$api_key_id" createdAt 2>/dev/null)

    if [ -z "$api_key_name" ]; then
        api_key_name="Unknown"
    fi

    if [ -z "$concurrency_limit" ] || [ "$concurrency_limit" = "0" ]; then
        concurrency_limit="无限制"
    fi

    if [ -z "$token_limit" ] || [ "$token_limit" = "0" ]; then
        token_limit="无限制"
    else
        token_limit=$(printf "%'d" $token_limit)
    fi

    echo "$api_key_name|$concurrency_limit|$token_limit|$created_at"
}

# 获取使用统计信息
get_usage_stats() {
    local api_key_id=$1
    local today=$(date '+%Y-%m-%d')
    local current_month=$(date '+%Y-%m')

    # 获取总体使用量
    local total_requests=$($REDIS_CMD hget "usage:$api_key_id" totalRequests 2>/dev/null)
    local total_tokens=$($REDIS_CMD hget "usage:$api_key_id" totalTokens 2>/dev/null)

    # 获取今日使用量
    local daily_requests=$($REDIS_CMD hget "usage:daily:$api_key_id:$today" requests 2>/dev/null)
    local daily_tokens=$($REDIS_CMD hget "usage:daily:$api_key_id:$today" tokens 2>/dev/null)

    total_requests=${total_requests:-0}
    total_tokens=${total_tokens:-0}
    daily_requests=${daily_requests:-0}
    daily_tokens=${daily_tokens:-0}

    echo "$total_requests|$total_tokens|$daily_requests|$daily_tokens"
}

# 格式化数字
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

# 获取系统信息
get_system_info() {
    # Redis信息
    local redis_info=$($REDIS_CMD info server 2>/dev/null)
    local redis_memory_info=$($REDIS_CMD info memory 2>/dev/null)

    local redis_version=$(echo "$redis_info" | grep redis_version | cut -d: -f2 | tr -d '\r' 2>/dev/null)
    local redis_uptime=$(echo "$redis_info" | grep uptime_in_seconds | cut -d: -f2 | tr -d '\r' 2>/dev/null)
    local used_memory=$(echo "$redis_memory_info" | grep used_memory_human | cut -d: -f2 | tr -d '\r' 2>/dev/null)

    local redis_uptime_hours=0
    if [ ! -z "$redis_uptime" ]; then
        redis_uptime_hours=$((redis_uptime / 3600))
    fi

    # 服务状态
    local service_status="unknown"
    local service_uptime="0"
    if command -v curl > /dev/null 2>&1; then
        local health_response=$(curl -s ${SERVICE_URL}/health 2>/dev/null)
        if [ $? -eq 0 ]; then
            service_status=$(echo "$health_response" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 | head -1)
            service_uptime=$(echo "$health_response" | grep -o '"uptime":[^,}]*' | cut -d: -f2 | head -1)
        fi
    fi

    local service_uptime_hours="0"
    if [ ! -z "$service_uptime" ] && [ "$service_uptime" != "null" ]; then
        service_uptime_hours=$(echo "scale=1; $service_uptime / 3600" | bc 2>/dev/null)
    fi

    echo "$redis_version|$redis_uptime_hours|$used_memory|$service_status|$service_uptime_hours"
}

# 主监控函数
monitor_enhanced() {
    while true; do
        clear
        echo "Claude Relay Service - 增强版实时监控 | $(date '+%Y-%m-%d %H:%M:%S')"
        echo "模式: $DISPLAY_MODE | 服务: $SERVICE_URL | Redis: $REDIS_HOST:$REDIS_PORT"
        echo "========================================"

        # 获取系统信息
        local system_info=$(get_system_info)
        local redis_version=$(echo "$system_info" | cut -d'|' -f1)
        local redis_uptime=$(echo "$system_info" | cut -d'|' -f2)
        local redis_memory=$(echo "$system_info" | cut -d'|' -f3)
        local service_status=$(echo "$system_info" | cut -d'|' -f4)
        local service_uptime=$(echo "$system_info" | cut -d'|' -f5)

        # 系统状态概览
        echo "系统状态概览："
        if [ "$service_status" = "healthy" ]; then
            echo "  服务: 健康 (运行 ${service_uptime}h)"
        else
            echo "  服务: 异常 ($service_status)"
        fi
        echo "  Redis: v${redis_version} (运行 ${redis_uptime}h, 内存 ${redis_memory})"
        echo ""

        # 获取并发信息
        local concurrency_keys=$($REDIS_CMD --scan --pattern "concurrency:*" 2>/dev/null)
        local total_concurrent=0
        local active_keys=0
        local concurrent_details=""

        if [ ! -z "$concurrency_keys" ]; then
            for key in $concurrency_keys; do
                local count=$($REDIS_CMD get "$key" 2>/dev/null)
                if [ ! -z "$count" ] && [ "$count" -gt 0 ]; then
                    local api_key_id=${key#concurrency:}
                    local key_info=$(get_api_key_info "$api_key_id")
                    local key_name=$(echo "$key_info" | cut -d'|' -f1)
                    local concurrency_limit=$(echo "$key_info" | cut -d'|' -f2)

                    concurrent_details="${concurrent_details}${key_name}:${count}/${concurrency_limit} "
                    total_concurrent=$((total_concurrent + count))
                    active_keys=$((active_keys + 1))
                fi
            done
        fi

        # 并发状态显示
        echo "当前并发状态："
        if [ $total_concurrent -eq 0 ]; then
            echo "  无活跃并发连接"
        else
            echo "  总并发: $total_concurrent 个连接 ($active_keys 个API Key)"
            if [ "$DISPLAY_MODE" = "detailed" ]; then
                echo "  详情: $concurrent_details"
            fi
        fi
        echo ""

        # API Key统计
        local total_keys=$($REDIS_CMD keys "apikey:*" 2>/dev/null | grep -v "apikey:hash_map" | wc -l)
        local total_accounts=$($REDIS_CMD keys "claude:account:*" 2>/dev/null | wc -l)

        echo "资源统计："
        echo "  API Keys: $total_keys 个"
        echo "  Claude账户: $total_accounts 个"

        # 详细模式显示更多信息
        if [ "$DISPLAY_MODE" = "detailed" ]; then
            echo ""
            echo "使用统计 (今日/总计)："

            # 获取所有API Key
            local api_keys=$($REDIS_CMD keys "apikey:*" 2>/dev/null | grep -v "apikey:hash_map")
            local total_daily_requests=0
            local total_daily_tokens=0
            local total_requests=0
            local total_tokens=0

            if [ ! -z "$api_keys" ]; then
                for key in $api_keys; do
                    local api_key_id=${key#apikey:}
                    local key_info=$(get_api_key_info "$api_key_id")
                    local key_name=$(echo "$key_info" | cut -d'|' -f1)
                    local usage_info=$(get_usage_stats "$api_key_id")

                    local key_total_requests=$(echo "$usage_info" | cut -d'|' -f1)
                    local key_total_tokens=$(echo "$usage_info" | cut -d'|' -f2)
                    local key_daily_requests=$(echo "$usage_info" | cut -d'|' -f3)
                    local key_daily_tokens=$(echo "$usage_info" | cut -d'|' -f4)

                    total_daily_requests=$((total_daily_requests + key_daily_requests))
                    total_daily_tokens=$((total_daily_tokens + key_daily_tokens))
                    total_requests=$((total_requests + key_total_requests))
                    total_tokens=$((total_tokens + key_total_tokens))

                    if [ $((key_daily_requests + key_total_requests)) -gt 0 ]; then
                        echo "  $key_name: ${key_daily_requests}req/$(format_number $key_daily_tokens) | ${key_total_requests}req/$(format_number $key_total_tokens)"
                    fi
                done
            fi

            echo "  系统总计: ${total_daily_requests}req/$(format_number $total_daily_tokens) | ${total_requests}req/$(format_number $total_tokens)"
        fi

        echo ""
        echo "刷新间隔: 5秒 | 按 Ctrl+C 退出 | 按 Enter 切换详细/简单模式"

        # 非阻塞读取用户输入
        read -t 5 user_input
        if [ $? -eq 0 ]; then
            case "$user_input" in
                "s"|"S"|"")
                    if [ "$DISPLAY_MODE" = "simple" ]; then
                        DISPLAY_MODE="detailed"
                    else
                        DISPLAY_MODE="simple"
                    fi
                    ;;
            esac
        fi
    done
}

# 信号处理
cleanup() {
    echo ""
    echo "监控已停止"
    exit 0
}

trap cleanup SIGINT SIGTERM

# 开始监控
monitor_enhanced

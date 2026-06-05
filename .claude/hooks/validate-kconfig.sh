#!/usr/bin/env bash
# =============================================================================
# .claude/hooks/validate-kconfig.sh
#
# PostToolUse 훅: .conf 파일이 수정될 때마다 자동 실행
# prj.conf의 CONFIG_* 심볼이 build/zephyr/.config에 실제로 반영됐는지 검증
#
# 트리거: Write | Edit | MultiEdit 도구가 .conf 파일에 적용된 후
# =============================================================================

set -euo pipefail

# --- 1. 수정된 파일이 .conf인지 확인 ---
FILE_PATH=$(jq -r '.tool_input.file_path // .tool_input.path // ""' < /dev/stdin 2>/dev/null || echo "")

if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ \.conf$ ]]; then
    exit 0  # .conf 파일이 아니면 조용히 종료
fi

echo "🔍 [Kconfig Hook] .conf 수정 감지: $FILE_PATH"

# --- 2. .config 존재 여부 확인 ---
# 수정된 .conf 파일의 위치에서 build 디렉토리 탐색
CONF_DIR=$(dirname "$FILE_PATH")
BUILD_CONFIG=""

# node_a / node_b / node_c 디렉토리 구조 탐색
for candidate in \
    "$CONF_DIR/build/zephyr/.config" \
    "$(dirname "$CONF_DIR")/build/zephyr/.config" \
    "build/zephyr/.config"
do
    if [[ -f "$candidate" ]]; then
        BUILD_CONFIG="$candidate"
        break
    fi
done

if [[ -z "$BUILD_CONFIG" ]]; then
    echo "⚠️  [Kconfig Hook] build/zephyr/.config 없음 — 빌드 후 재검증 필요"
    echo "   힌트: west build -b nrf52840dk/nrf52840"
    exit 0
fi

echo "   .config 발견: $BUILD_CONFIG"

# --- 3. prj.conf의 CONFIG_* 심볼 추출 ---
CONF_SYMBOLS=$(grep -E "^CONFIG_[A-Z0-9_]+=y$" "$FILE_PATH" | sort || true)

if [[ -z "$CONF_SYMBOLS" ]]; then
    echo "✅ [Kconfig Hook] 활성화 심볼 없음 — 검증 생략"
    exit 0
fi

# --- 4. Silent Failure 탐지 ---
MISSING=()

while IFS= read -r line; do
    SYMBOL=$(echo "$line" | cut -d'=' -f1)

    if ! grep -q "^${SYMBOL}=y$" "$BUILD_CONFIG" 2>/dev/null; then
        MISSING+=("$SYMBOL")
    fi
done <<< "$CONF_SYMBOLS"

# --- 5. 결과 출력 ---
if [[ ${#MISSING[@]} -eq 0 ]]; then
    echo "✅ [Kconfig Hook] 모든 심볼 정상 반영됨"
else
    echo ""
    echo "⚠️  [Kconfig Hook] Silent Failure 감지 — 아래 심볼이 .config에 없음:"
    echo "─────────────────────────────────────────────"
    for sym in "${MISSING[@]}"; do
        echo "   ✗ $sym"

        # 의존성 힌트 출력
        DEP_INFO=$(grep -rn "config ${sym#CONFIG_}" \
            zephyr/ modules/ --include="Kconfig*" -A 5 2>/dev/null \
            | grep "depends on" | head -3 || true)

        if [[ -n "$DEP_INFO" ]]; then
            echo "     depends on: $(echo "$DEP_INFO" | sed 's/.*depends on//' | tr -s ' ' | head -1)"
        fi
    done
    echo "─────────────────────────────────────────────"
    echo ""
    echo "   해결 방법:"
    echo "   1. 누락된 심볼의 depends on 조건을 prj.conf에 추가"
    echo "   2. west build 재실행 후 grep '<SYMBOL>' build/zephyr/.config 확인"
    echo "   3. 상세 분석: .claude/skills/kconfig-ref.md 참조"
    echo ""

    # 이 프로젝트 주요 의존성 힌트
    for sym in "${MISSING[@]}"; do
        case "$sym" in
            CONFIG_CMSIS_DSP)
                echo "   💡 CONFIG_CMSIS_DSP requires: CONFIG_FPU=y CONFIG_FPU_SHARING=y"
                ;;
            CONFIG_BT_MESH_RELAY)
                echo "   💡 CONFIG_BT_MESH_RELAY requires: CONFIG_BT_MESH=y"
                ;;
            CONFIG_BT_MESH_GATT_PROXY)
                echo "   💡 CONFIG_BT_MESH_GATT_PROXY requires: CONFIG_BT_MESH=y CONFIG_BT_GATT=y"
                ;;
            CONFIG_NVS)
                echo "   💡 CONFIG_NVS requires: CONFIG_FLASH=y CONFIG_FLASH_MAP=y"
                ;;
            CONFIG_MPU6050)
                echo "   💡 CONFIG_MPU6050 requires: CONFIG_SENSOR=y CONFIG_I2C=y"
                ;;
        esac
    done

    # 경고지만 빌드를 막지는 않음 (exit 0)
    # 강제 중단이 필요하면 exit 1로 변경
    exit 0
fi

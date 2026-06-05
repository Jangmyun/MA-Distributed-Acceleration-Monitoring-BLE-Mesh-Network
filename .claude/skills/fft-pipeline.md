# Skill: FFT 파이프라인 및 이상 감지 알고리즘

## 언제 이 스킬을 사용하나

- `arm_rfft_fast_f32` 관련 코드를 작성하거나 디버깅할 때
- Hanning Window 구현을 추가/수정할 때
- SFM / DFS / RSD 이상 감지 알고리즘 로직을 다룰 때
- 기준선(Baseline) 학습 및 NVS 저장 코드를 작성할 때
- FFT 결과가 이상하거나 이상 감지가 오발동/미발동할 때

---

## FFT 파이프라인 전체 구조

```
MPU-6050 Z축 (1 kHz, 256 샘플 DMA)
        ↓
[Hanning Window 적용]      ← 스펙트럼 누설 억제
        ↓
[arm_rfft_fast_f32]        ← CMSIS-DSP 256-point RFFT
        ↓
[arm_cmplx_mag_f32]        ← 복소수 → 진폭 (128 빈)
        ↓
[이상 감지: SFM / DFS / RSD]
        ↓
[심각도 판정] → BLE Mesh publish
```

- **샘플링 주파수:** Fs = 1000 Hz
- **FFT 크기:** N = 256
- **출력 빈 수:** 128 (0 ~ 500 Hz)
- **주파수 분해능:** Δf = Fs / N = 3.906 Hz
- **처리 주기:** ~0.256초 (256 샘플 수집 완료마다)

---

## Kconfig 전제 조건 (먼저 확인)

```
CONFIG_CMSIS_DSP=y
CONFIG_FPU=y
CONFIG_FPU_SHARING=y
```

확인 명령: `grep "CONFIG_CMSIS_DSP\|CONFIG_FPU" build/zephyr/.config`

---

## 구현 패턴

### 1. 초기화

```c
#include <arm_math.h>

#define FFT_SIZE 256
#define FFT_BINS (FFT_SIZE / 2)   // 128

static arm_rfft_fast_instance_f32 fft_inst;
static float32_t hanning_lut[FFT_SIZE];

void fft_init(void)
{
    arm_rfft_fast_init_f32(&fft_inst, FFT_SIZE);

    /* Hanning Window LUT 사전 계산 */
    for (int i = 0; i < FFT_SIZE; i++) {
        hanning_lut[i] = 0.5f * (1.0f - arm_cos_f32(
            2.0f * PI * i / (FFT_SIZE - 1)));
    }
}
```

> LUT를 `static const`로 Flash에 두면 RAM 절약 가능.
> 단, `arm_cos_f32`는 런타임 계산이므로 부팅 시 1회만 실행.

---

### 2. Hanning Window 적용

```c
static void apply_hanning(float32_t *buf, uint32_t len)
{
    for (uint32_t i = 0; i < len; i++) {
        buf[i] *= hanning_lut[i];
    }
    /* 또는 CMSIS-DSP vector multiply 사용 (속도 최적화):
     * arm_mult_f32(buf, hanning_lut, buf, len); */
}
```

---

### 3. RFFT + 진폭 계산

```c
static float32_t fft_out[FFT_SIZE];    // 복소수 출력 (실수/허수 교번)
static float32_t mag[FFT_BINS];        // 진폭 스펙트럼

void run_fft(float32_t *samples, float32_t *mag_out)
{
    apply_hanning(samples, FFT_SIZE);

    /* RFFT: ifftFlag = 0 (forward), bitReverseFlag = 1 */
    arm_rfft_fast_f32(&fft_inst, samples, fft_out, 0);

    /* 복소수 → 진폭 */
    arm_cmplx_mag_f32(fft_out, mag_out, FFT_BINS);
}
```

> `fft_out[0]`은 DC 성분(실수), `fft_out[1]`은 Nyquist 성분.
> `arm_cmplx_mag_f32`는 이 레이아웃을 올바르게 처리함.

---

### 4. 이상 감지 — 3중 지표

#### 4-1. 기준선 구조체

```c
#define BASELINE_LEN FFT_BINS  // 128

typedef struct {
    float32_t mean[BASELINE_LEN];
    float32_t stddev[BASELINE_LEN];
    float32_t dom_freq_hz;     // 기준선 지배 주파수
} baseline_t;
```

#### 4-2. SFM (Spectral Flatness Measure)

```c
/* SFM = 기하평균 / 산술평균
 * 값이 1에 가까울수록 평탄(노이즈), 0에 가까울수록 단일 피크 */
float32_t compute_sfm(float32_t *mag, uint32_t len)
{
    float32_t log_sum = 0.0f;
    float32_t arith_mean;

    for (uint32_t i = 1; i < len; i++) {  // i=0 DC 제외
        log_sum += logf(mag[i] + 1e-9f);
    }
    float32_t geo_mean = expf(log_sum / (len - 1));
    arm_mean_f32(mag + 1, len - 1, &arith_mean);

    return (arith_mean > 1e-9f) ? (geo_mean / arith_mean) : 0.0f;
}
```

#### 4-3. DFS (Dominant Frequency Shift)

```c
/* 현재 최대 진폭 빈 주파수 - 기준선 지배 주파수 */
float32_t compute_dfs(float32_t *mag, float32_t baseline_dom_hz)
{
    uint32_t max_idx;
    float32_t max_val;
    arm_max_f32(mag, FFT_BINS, &max_val, &max_idx);

    float32_t dom_hz = max_idx * (1000.0f / FFT_SIZE);  // Δf = 3.906 Hz
    return fabsf(dom_hz - baseline_dom_hz);
}
```

#### 4-4. RSD (RMS Spectral Deviation)

```c
/* L2 거리(RMS): 현재 스펙트럼과 기준선 mean의 차이 */
float32_t compute_rsd(float32_t *mag, baseline_t *bl)
{
    float32_t diff[FFT_BINS];
    float32_t rms;

    arm_sub_f32(mag, bl->mean, diff, FFT_BINS);
    arm_rms_f32(diff, FFT_BINS, &rms);
    return rms;
}
```

---

### 5. 심각도 판정

```c
#define SFM_THRESHOLD   0.25f   // 정상 기준선 SFM에서 +0.1 여유
#define DFS_THRESHOLD   15.0f   // Hz
#define RSD_THRESHOLD   0.15f   // 기준선 RMS 대비

typedef enum { SEVERITY_NORMAL, SEVERITY_WARNING, SEVERITY_CRITICAL } severity_t;

severity_t classify_severity(float32_t sfm, float32_t dfs, float32_t rsd)
{
    int exceed = 0;
    if (sfm > SFM_THRESHOLD) exceed++;
    if (dfs > DFS_THRESHOLD) exceed++;
    if (rsd > RSD_THRESHOLD) exceed++;

    if (exceed >= 2) return SEVERITY_CRITICAL;
    if (exceed == 1) return SEVERITY_WARNING;
    return SEVERITY_NORMAL;
}
```

---

## 기준선 학습 및 NVS 저장

```c
/* 부팅 후 30초, 1 kHz 샘플링 → ~117회 FFT 수행
 * 각 빈별 mean, stddev 계산 후 NVS에 저장 */

/* NVS 저장 키 */
#define NVS_KEY_BASELINE_MEAN   1
#define NVS_KEY_BASELINE_STD    2
#define NVS_KEY_DOM_FREQ        3
```

> NVS 파티션이 `pm_static.yml` 또는 DTS flash 파티션에 정의되어야 함.
> 관련 Kconfig: `CONFIG_NVS=y`, `CONFIG_FLASH=y`, `CONFIG_FLASH_MAP=y`

---

## 디버깅 체크리스트

| 증상 | 확인 사항 |
|------|-----------|
| 빌드 시 `arm_rfft_fast_f32` undefined | `CONFIG_CMSIS_DSP=y` + `CONFIG_FPU=y` 확인 |
| 스펙트럼이 전부 0 | DMA 버퍼 캐시 flush 필요 (`SCB_CleanDCache`) |
| 주파수 빈이 절반만 나옴 | `arm_cmplx_mag_f32`에 `FFT_BINS`(128) 전달 확인 |
| SFM이 항상 1.0 | log 계산에서 DC(i=0) 제외 여부 확인 |
| 이상 감지 오발동 | 기준선 학습 중 진동원 있었는지 확인, 임계값 조정 |
| HardFault (FFT 직후) | `fft_out` 배열 크기 FFT_SIZE 이상인지 확인 |

---

## top8 빈 추출 (BLE Mesh 전송용)

```c
/* 전체 128빈 대신 에너지 상위 8빈 인덱스+값 전송 (<40 bytes) */
void extract_top8(float32_t *mag, uint16_t *out_bins, uint8_t n)
{
    float32_t tmp[FFT_BINS];
    memcpy(tmp, mag, sizeof(tmp));

    for (uint8_t i = 0; i < n; i++) {
        uint32_t idx;
        float32_t val;
        arm_max_f32(tmp, FFT_BINS, &val, &idx);
        out_bins[i] = (uint16_t)(val);  // 정수 변환 (정밀도 손실 주의)
        tmp[idx] = 0.0f;               // 다음 최대값 찾기 위해 0으로
    }
}
```

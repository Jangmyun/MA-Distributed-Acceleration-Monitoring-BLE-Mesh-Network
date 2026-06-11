/*
 * BLE Mesh 분산 가속도 모니터링 노드
 *
 * 동작:
 *   1. ADXL345 (I2C 0x53) 에서 X/Y/Z 가속도를 500 ms 마다 읽는다.
 *   2. Provisioned 상태이면 BLE Mesh로 데이터를 publish 한다.
 *      메시지 포맷: "A:<x_centi>,<y_centi>,<z_centi>"
 *      예) "A:123,-234,981" → x=1.23, y=-2.34, z=9.81 m/s²
 *   3. 다른 노드의 데이터를 수신하면 model_handler가 파싱해 저장한다.
 *   4. LCD 1602 (PCF8574 I2C 백팩 0x27) 에 표시한다.
 *      Line 0: 로컬 노드 X, Y 가속도
 *      Line 1: 수신한 원격 노드 주소 + X 가속도
 *              (미수신: "Mesh: waiting..."  / 미프로비전: "Mesh: no prov  ")
 *
 * I2C 버스 (P0.26 SDA / P0.27 SCL) 공유:
 *   ADXL345  @ 0x53
 *   PCF8574  @ 0x27
 *
 * BLE Mesh 프로비저닝:
 *   nRF Mesh 앱 또는 UART shell 명령으로 수행한다.
 *   프로비전 후 Chat CLI 모델에 App Key 바인딩 + 그룹 주소 구독 설정 필요.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/settings/settings.h>
#include <bluetooth/mesh/dk_prov.h>
#include <dk_buttons_and_leds.h>
#include <stdio.h>

#include "model_handler.h"

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(chat, CONFIG_LOG_DEFAULT_LEVEL);

#define ACCEL_NODE              DT_NODELABEL(adxl345)
#define LCD_I2C_NODE            DT_NODELABEL(i2c0)
#define LCD_ADDR                0x27
#define POLL_INTERVAL_MS        200   /* 센서 샘플링 주기 (LCD 갱신 기준) */
#define CHANGE_THRESHOLD_CENTI  5     /* 변화 감지 임계값: 0.05 m/s² */
#define PUB_INTERVAL_MS         1000  /* BLE Mesh 전송 간격: 변화 감지 시 최대 1회/초 */

/* PCF8574 핀 마스크 */
#define LCD_RS  BIT(0)
#define LCD_RW  BIT(1)
#define LCD_E   BIT(2)
#define LCD_BL  BIT(3)

static const struct device *lcd_i2c;

/* ── 이벤트 기반 publish 상태 ─────────────────────────────────────────────── */

static int32_t last_pub_x = INT32_MIN;
static int32_t last_pub_y = INT32_MIN;
static int32_t last_pub_z = INT32_MIN;
static int64_t last_pub_ms;

static inline int32_t i32_abs(int32_t v) { return v < 0 ? -v : v; }

static bool accel_needs_publish(int32_t x, int32_t y, int32_t z)
{
	int64_t elapsed = k_uptime_get() - last_pub_ms;

	/* keepalive: 변화 여부 무관하게 강제 전송 */
	if (elapsed >= KEEPALIVE_INTERVAL_MS) {
		return true;
	}
	/* 최소 전송 간격 미달 시 변화가 있어도 전송 보류 */
	if (elapsed < MIN_PUB_INTERVAL_MS) {
		return false;
	}
	return (i32_abs(x - last_pub_x) > CHANGE_THRESHOLD_CENTI ||
		i32_abs(y - last_pub_y) > CHANGE_THRESHOLD_CENTI ||
		i32_abs(z - last_pub_z) > CHANGE_THRESHOLD_CENTI);
}

/* ── PCF8574 / HD44780 저수준 ──────────────────────────────────────────── */

static void pcf_write(uint8_t val)
{
	i2c_write(lcd_i2c, &val, 1, LCD_ADDR);
}

static void lcd_pulse_enable(uint8_t data)
{
	pcf_write(data | LCD_E);
	k_busy_wait(1);
	pcf_write(data & ~LCD_E);
	k_busy_wait(50);
}

static void lcd_write_nibble(uint8_t nibble, uint8_t flags)
{
	uint8_t data = (nibble << 4) | flags | LCD_BL;
	lcd_pulse_enable(data);
}

static void lcd_send(uint8_t byte, uint8_t flags)
{
	lcd_write_nibble(byte >> 4, flags);
	lcd_write_nibble(byte & 0x0F, flags);
	k_busy_wait(50);
}

static inline void lcd_cmd(uint8_t cmd) { lcd_send(cmd, 0); }
static inline void lcd_putc(char c)     { lcd_send((uint8_t)c, LCD_RS); }

/* ── LCD 초기화 (4비트 모드) ─────────────────────────────────────────────── */

static void lcd_init(void)
{
	k_msleep(50);

	/* 4비트 초기화 시퀀스 */
	lcd_write_nibble(0x03, 0); k_msleep(5);
	lcd_write_nibble(0x03, 0); k_busy_wait(150);
	lcd_write_nibble(0x03, 0); k_busy_wait(150);
	lcd_write_nibble(0x02, 0); k_busy_wait(150);

	lcd_cmd(0x28); /* 4비트, 2라인, 5×8 */
	lcd_cmd(0x0C); /* Display ON, 커서 OFF */
	lcd_cmd(0x06); /* 자동 증가, 시프트 없음 */
	lcd_cmd(0x01); /* 화면 지우기 */
	k_msleep(2);
}

static void lcd_set_cursor(uint8_t col, uint8_t row)
{
	uint8_t addr = col + (row == 0 ? 0x00 : 0x40);
	lcd_cmd(0x80 | addr);
}

static void lcd_puts(const char *s)
{
	while (*s) {
		lcd_putc(*s++);
	}
}

/* ── 값 포맷 함수 ──────────────────────────────────────────────────────── */

/*
 * sensor_value → 6문자 문자열: <부호><2정수>.<2소수>
 * 예) 1.23 → " 01.23"   -2.34 → "-02.34"
 * buf 크기: 최소 7바이트 (6문자 + null)
 */
static void fmt_sv(char *buf, const struct sensor_value *sv)
{
	int32_t i = sv->val1;
	int32_t f = sv->val2;

	bool neg = (i < 0) || (i == 0 && f < 0);
	if (i < 0) { i = -i; }
	if (f < 0) { f = -f; }

	f = f / 10000; /* micro → centi */

	snprintf(buf, 7, "%c%02d.%02d", neg ? '-' : ' ', (int)i, (int)f);
}

/*
 * centiunits (val × 100) → 6문자 문자열 (fmt_sv와 동일 포맷).
 * 원격 노드 수신 데이터 표시에 사용.
 * buf 크기: 최소 7바이트
 */
static void fmt_centi(char *buf, int32_t cv)
{
	bool neg = cv < 0;

	if (neg) { cv = -cv; }
	snprintf(buf, 7, "%c%02d.%02d", neg ? '-' : ' ',
		 (int)(cv / 100), (int)(cv % 100));
}

/* ── sensor_value → centiunits 변환 ────────────────────────────────────── */

static int32_t sv_to_centi(const struct sensor_value *sv)
{
	return sv->val1 * 100 + sv->val2 / 10000;
}

/* ── 메인 ──────────────────────────────────────────────────────────────── */

int main(void)
{
	int err;

	const struct device *accel = DEVICE_DT_GET(ACCEL_NODE);

	lcd_i2c = DEVICE_DT_GET(LCD_I2C_NODE);

	/* ── 하드웨어 초기화 ── */
	if (!device_is_ready(lcd_i2c)) {
		printk("I2C bus not ready\n");
		return -ENODEV;
	}

	if (!device_is_ready(accel)) {
		printk("ADXL345 not ready\n");
		return -ENODEV;
	}

	lcd_init();
	lcd_set_cursor(0, 0);
	lcd_puts(" BLE Mesh Init  ");
	lcd_set_cursor(0, 1);
	lcd_puts(" Please wait... ");

	/* ── DK 버튼 + LED 초기화 (프로비저닝 OOB + attention blink) ── */
	/* NCS v2.5.0: dk_buttons_and_leds_init() 제거 → 분리 호출 */
	err = dk_leds_init();
	if (err) {
		printk("LEDs init failed: %d\n", err);
		return err;
	}

	err = dk_buttons_init(NULL);
	if (err) {
		printk("Buttons init failed: %d\n", err);
		return err;
	}

	/* ── BT 스택 활성화 ── */
	err = bt_enable(NULL);
	if (err) {
		printk("bt_enable failed: %d\n", err);
		return err;
	}

	/* ── BLE Mesh 초기화 ──
	 * bt_mesh_dk_prov_init(): DK 보드 기반 OOB 프로비저닝 콜백 반환
	 *   - Output OOB: LED blink (숫자 표시)
	 *   - Input  OOB: 버튼 누름 횟수
	 * model_handler_init(): Chat CLI Vendor Model composition 반환
	 */
	err = bt_mesh_init(bt_mesh_dk_prov_init(), model_handler_init());
	if (err) {
		printk("bt_mesh_init failed: %d\n", err);
		return err;
	}

	/* ── Flash 설정 복원 (이전 프로비저닝 / 네트워크 키 로드) ── */
	if (IS_ENABLED(CONFIG_BT_SETTINGS)) {
		settings_load();
	}

	/* ── 프로비저닝 Bearer 활성화 ──
	 * settings_load()로 이미 프로비저닝된 경우 no-op.
	 * 미프로비저닝 상태이면 ADV + GATT bearer로 광고 시작 → 앱에서 인식 가능.
	 */
	bt_mesh_prov_enable(BT_MESH_PROV_ADV | BT_MESH_PROV_GATT);

	lcd_set_cursor(0, 0);
	lcd_puts("BLE Mesh Ready! ");
	lcd_set_cursor(0, 1);
	lcd_puts(bt_mesh_is_provisioned() ? "Provisioned!    "
					  : "Use nRF Mesh app");
	k_msleep(1500);

	/* ── 메인 루프: 센서 읽기 → 변화 감지 → Mesh publish → LCD 업데이트 ── */
	while (1) {
		struct sensor_value ax, ay, az;
		char xbuf[7], ybuf[7];
		char line[17];

		/* 1. ADXL345 샘플 취득 */
		if (sensor_sample_fetch(accel) < 0) {
			lcd_set_cursor(0, 0);
			lcd_puts("  Fetch Error   ");
			k_msleep(POLL_INTERVAL_MS);
			continue;
		}

		sensor_channel_get(accel, SENSOR_CHAN_ACCEL_X, &ax);
		sensor_channel_get(accel, SENSOR_CHAN_ACCEL_Y, &ay);
		sensor_channel_get(accel, SENSOR_CHAN_ACCEL_Z, &az);

		/* 2. 변화 감지 후 BLE Mesh publish
		 *    - 어느 축이든 CHANGE_THRESHOLD_CENTI 초과 변화 시 즉시 전송
		 *    - 변화 없어도 KEEPALIVE_INTERVAL_MS 마다 강제 전송 (gateway 온라인 감지용)
		 */
		if (bt_mesh_is_provisioned()) {
			int32_t cx = sv_to_centi(&ax);
			int32_t cy = sv_to_centi(&ay);
			int32_t cz = sv_to_centi(&az);

			if (accel_needs_publish(cx, cy, cz)) {
				model_handler_publish_accel(cx, cy, cz);
				last_pub_x  = cx;
				last_pub_y  = cy;
				last_pub_z  = cz;
				last_pub_ms = k_uptime_get();
			}
		}

		/* 3. LCD Line 0: 로컬 X, Y 가속도 */
		fmt_sv(xbuf, &ax);
		fmt_sv(ybuf, &ay);
		snprintf(line, sizeof(line), "X=%sY=%s", xbuf, ybuf);
		lcd_set_cursor(0, 0);
		lcd_puts(line);

		/* 4. LCD Line 1: 원격 노드 데이터 또는 상태 메시지 */
		if (!bt_mesh_is_provisioned()) {
			lcd_set_cursor(0, 1);
			lcd_puts("Mesh: no prov   ");
		} else {
			const struct model_handler_remote_accel *rem =
				model_handler_get_remote_accel();

			if (!rem->valid) {
				lcd_set_cursor(0, 1);
				lcd_puts("Mesh: waiting...");
			} else {
				/*
				 * 원격 노드 주소(4자리 hex) + X 가속도 표시
				 * 예) "R:0002 X+01.23  " (16자)
				 */
				char rx_buf[7];

				fmt_centi(rx_buf, rem->x_centi);
				snprintf(line, sizeof(line),
					 "R:%04X X%s   ",
					 rem->addr, rx_buf);
				lcd_set_cursor(0, 1);
				lcd_puts(line);
			}
		}

		k_msleep(POLL_INTERVAL_MS);
	}

	return 0;
}

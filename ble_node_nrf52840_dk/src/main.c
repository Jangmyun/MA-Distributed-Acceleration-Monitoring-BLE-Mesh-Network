/*
 * ADXL345 가속도계 (GY-291) printk 출력 테스트
 *
 * GY-291 연결:
 *   GND  → GND  (J2 핀1)
 *   VCC  → 3.3V (J2 핀2)
 *   CS   → 3.3V (J2 핀2)   — I2C 모드
 *   SDO  → GND  (J2 핀1)   — I2C 주소 0x53
 *   SDA  → P0.26 (J3 핀7)
 *   SCL  → P0.27 (J3 핀8)
 *   INT1 → P1.08 (선택사항)
 *   INT2 → P1.10 (선택사항)
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>

#define ACCEL_NODE DT_NODELABEL(adxl345)
#define POLL_INTERVAL_MS 500

static inline float sv_to_f(const struct sensor_value *sv)
{
	return (float)sv->val1 + (float)sv->val2 * 1e-6f;
}

int main(void)
{
	const struct device *accel = DEVICE_DT_GET(ACCEL_NODE);

	if (!device_is_ready(accel)) {
		printk("ADXL345 not ready — 배선/주소(0x53) 확인\n");
		return -ENODEV;
	}
	printk("ADXL345 ready. 출력 시작 (주기 %d ms)\n", POLL_INTERVAL_MS);

	while (1) {
		struct sensor_value ax, ay, az;

		if (sensor_sample_fetch(accel) < 0) {
			printk("fetch error\n");
			k_msleep(POLL_INTERVAL_MS);
			continue;
		}

		sensor_channel_get(accel, SENSOR_CHAN_ACCEL_X, &ax);
		sensor_channel_get(accel, SENSOR_CHAN_ACCEL_Y, &ay);
		sensor_channel_get(accel, SENSOR_CHAN_ACCEL_Z, &az);

		printk("X=%d.%06d  Y=%d.%06d  Z=%d.%06d m/s2\n",
		       ax.val1, ax.val2,
		       ay.val1, ay.val2,
		       az.val1, az.val2);

		k_msleep(POLL_INTERVAL_MS);
	}

	return 0;
}

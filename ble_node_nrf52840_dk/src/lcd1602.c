#include "lcd1602.h"

#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>

/*
 * PCF8574 → HD44780 비트 배치 (PCF8574 백팩 표준 배선)
 *
 *  PCF 핀 : P7  P6  P5  P4  P3  P2  P1  P0
 *  HD44780: D7  D6  D5  D4  BL  EN  RW  RS
 */
#define RS  BIT(0)   /* Register Select : 0=cmd, 1=data */
#define RW  BIT(1)   /* Read/Write      : 항상 0(write) */
#define EN  BIT(2)   /* Enable 클럭 */
#define BL  BIT(3)   /* 백라이트 (1=on) */

/* HD44780 명령 */
#define CMD_CLEAR        0x01
#define CMD_HOME         0x02
#define CMD_ENTRY_MODE   0x06   /* 커서 우측 이동, 화면 shift 없음 */
#define CMD_DISPLAY_ON   0x0C   /* 디스플레이 ON, 커서/깜빡임 OFF */
#define CMD_FUNC_SET_4B  0x28   /* 4비트, 2줄, 5×8 폰트 */

static int pcf8574_write(const struct device *dev, uint8_t addr, uint8_t data)
{
	return i2c_write(dev, &data, 1, addr);
}

/* EN 펄스: LOW → HIGH → LOW  (Rising Edge 보장) */
static int lcd_pulse_en(const struct device *dev, uint8_t addr, uint8_t data)
{
	int ret;

	/* EN=0 먼저 확정 → Rising Edge 생성 */
	ret = pcf8574_write(dev, addr, data & ~EN);
	if (ret) {
		return ret;
	}
	k_busy_wait(1);
	ret = pcf8574_write(dev, addr, data | EN);   /* Rising Edge */
	if (ret) {
		return ret;
	}
	k_busy_wait(1);                              /* tEH >450 ns */
	ret = pcf8574_write(dev, addr, data & ~EN);  /* Falling Edge */
	if (ret) {
		return ret;
	}
	k_busy_wait(50);                             /* tExec >37 µs */
	return 0;
}

/* 상위 4비트 nibble 전송 */
static int lcd_write_nibble(const struct device *dev, uint8_t addr,
			    uint8_t nibble, uint8_t flags)
{
	/* 상위 4비트(D7-D4)에 nibble 배치 + 백라이트 상시 ON */
	uint8_t data = ((nibble & 0x0F) << 4) | BL | (flags & (RS | RW));

	return lcd_pulse_en(dev, addr, data);
}

/* 1바이트 명령 또는 데이터 전송 (4비트 모드: 상위 nibble → 하위 nibble) */
static int lcd_send_byte(const struct device *dev, uint8_t addr,
			 uint8_t byte, uint8_t flags)
{
	int ret;

	ret = lcd_write_nibble(dev, addr, byte >> 4, flags);
	if (ret) {
		return ret;
	}
	return lcd_write_nibble(dev, addr, byte & 0x0F, flags);
}

int lcd1602_init(const struct device *i2c_dev, uint8_t addr)
{
	int ret;

	/*
	 * PCF8574 전원 인가 시 모든 핀이 HIGH → EN=1 상태.
	 * EN을 명시적으로 LOW로 끌어내려 Rising Edge를 보장한다.
	 */
	ret = pcf8574_write(i2c_dev, addr, BL); /* EN=0, RS=0, BL=1 */
	if (ret) {
		return ret;
	}
	k_msleep(50); /* 전원 인가 후 >40 ms 대기 */

	/*
	 * HD44780 4비트 초기화 시퀀스 (datasheet p.46)
	 * 8비트 모드 명령(0x03)을 3회 보낸 후 4비트 모드로 전환
	 */
	ret  = lcd_write_nibble(i2c_dev, addr, 0x03, 0);
	k_msleep(5);
	ret |= lcd_write_nibble(i2c_dev, addr, 0x03, 0);
	k_msleep(1);
	ret |= lcd_write_nibble(i2c_dev, addr, 0x03, 0);
	k_msleep(1);
	ret |= lcd_write_nibble(i2c_dev, addr, 0x02, 0); /* 4비트 모드 전환 */
	k_msleep(1);
	if (ret) {
		return ret;
	}

	ret  = lcd_send_byte(i2c_dev, addr, CMD_FUNC_SET_4B, 0);
	ret |= lcd_send_byte(i2c_dev, addr, CMD_DISPLAY_ON, 0);
	ret |= lcd_send_byte(i2c_dev, addr, CMD_CLEAR, 0);
	k_msleep(2); /* clear 명령: >1.52 ms 필요 */
	ret |= lcd_send_byte(i2c_dev, addr, CMD_ENTRY_MODE, 0);

	return ret;
}

int lcd1602_clear(const struct device *i2c_dev, uint8_t addr)
{
	int ret = lcd_send_byte(i2c_dev, addr, CMD_CLEAR, 0);

	k_msleep(2);
	return ret;
}

int lcd1602_set_cursor(const struct device *i2c_dev, uint8_t addr,
		       uint8_t col, uint8_t row)
{
	/* HD44780 DDRAM 주소: 1행=0x00, 2행=0x40 */
	static const uint8_t row_base[] = {0x00, 0x40};

	if (row > 1) {
		row = 1;
	}
	if (col > 15) {
		col = 15;
	}
	return lcd_send_byte(i2c_dev, addr,
			     0x80 | (row_base[row] + col), 0);
}

int lcd1602_write_char(const struct device *i2c_dev, uint8_t addr, char c)
{
	return lcd_send_byte(i2c_dev, addr, (uint8_t)c, RS);
}

int lcd1602_write_str(const struct device *i2c_dev, uint8_t addr,
		      const char *str)
{
	int ret = 0;

	while (*str && !ret) {
		ret = lcd1602_write_char(i2c_dev, addr, *str++);
	}
	return ret;
}

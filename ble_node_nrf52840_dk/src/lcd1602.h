#ifndef LCD1602_H
#define LCD1602_H

#include <zephyr/device.h>
#include <stdint.h>

/*
 * PCF8574 I2C 주소
 *  0x27 : PCF8574T  (A0=A1=A2=1, 출하 기본값)
 *  0x3F : PCF8574AT (A0=A1=A2=1)
 */
#define LCD1602_DEFAULT_ADDR 0x27

int lcd1602_init(const struct device *i2c_dev, uint8_t addr);
int lcd1602_clear(const struct device *i2c_dev, uint8_t addr);
int lcd1602_set_cursor(const struct device *i2c_dev, uint8_t addr,
		       uint8_t col, uint8_t row);
int lcd1602_write_str(const struct device *i2c_dev, uint8_t addr,
		      const char *str);
int lcd1602_write_char(const struct device *i2c_dev, uint8_t addr, char c);

#endif /* LCD1602_H */

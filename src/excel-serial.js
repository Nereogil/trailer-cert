// Excel counts days from 1899-12-30. The offset absorbs Excel's fictional
// 29 February 1900, which is why the epoch is the 30th rather than the 31st.
const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;

export function toExcelSerial(date) {
  return Math.floor((date.getTime() - EPOCH) / DAY);
}

export function fromExcelSerial(serial) {
  return new Date(EPOCH + serial * DAY);
}

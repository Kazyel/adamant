export function dateValue(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function readDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && dateValue(date) === value ? date : null;
}

export function dateLabel(value: string): string {
  return (
    readDate(value)?.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }) ?? value
  );
}

export function shiftMonth(date: Date, amount: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + amount);
  const last = new Date(result);
  last.setMonth(last.getMonth() + 1, 0);
  result.setDate(Math.min(day, last.getDate()));
  return result;
}

export function monthDays(date: Date): Date[] {
  const first = new Date(date);
  first.setDate(1);
  first.setDate(1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(first);
    day.setDate(first.getDate() + index);
    return day;
  });
}

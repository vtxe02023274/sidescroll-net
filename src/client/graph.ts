/**
 * Rolling line graph of a few numbers, one sample per frame. Each series has
 * its own scale so small and large values can share the chart.
 */
export class Graph {
  private readonly series: { label: string; color: string; values: number[]; max: number }[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly length = 240,
  ) {}

  add(label: string, color: string, max: number): number {
    this.series.push({ label, color, values: [], max });
    return this.series.length - 1;
  }

  push(index: number, value: number): void {
    const s = this.series[index]!;
    s.values.push(value);
    if (s.values.length > this.length) s.values.shift();
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px monospace';
    this.series.forEach((s, i) => {
      // Grow the scale when a value goes past it, so spikes stay on the chart.
      const max = Math.max(s.max, ...s.values);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      s.values.forEach((v, x) => {
        const px = (x / (this.length - 1)) * width;
        const py = height - 2 - (v / max) * (height - 16);
        if (x) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.stroke();
      const last = s.values.at(-1) ?? 0;
      ctx.fillStyle = s.color;
      ctx.fillText(
        `${s.label} ${Number.isInteger(last) ? last : last.toFixed(1)}`,
        6 + i * 170,
        11,
      );
    });
  }
}

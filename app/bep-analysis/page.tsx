"use client";
import React, { useState } from "react";
import ReactECharts from "echarts-for-react";

// 生成2025年1月到2026年5月的月份标签
const months: string[] = [];
for (let y = 2025; y <= 2026; y++) {
  const start = y === 2025 ? 1 : 1;
  const end = y === 2026 ? 5 : 12;
  for (let m = start; m <= end; m++) {
    months.push(`${y}-${m.toString().padStart(2, "0")}`);
  }
}

// 2025、2026年每百万token成本预测（美元）
const inputCostStart = 1.25;
const inputCostEnd = 0.3;
const outputCostStart = 5;
const outputCostEnd = 1.25;
const usd2cny = 7.2;
const tokensPerHour = 100_000;

// 等比插值函数
function interpolateGeometric(start: number, end: number, steps: number, idx: number) {
  if (steps === 1) return start;
  const ratio = Math.pow(end / start, 1 / (steps - 1));
  return start * Math.pow(ratio, idx);
}

function calcDayCost(inputCost: number, outputCost: number, hoursPerDay: number) {
  const totalTokens = tokensPerHour * hoursPerDay;
  const inputTokens = totalTokens / 2;
  const outputTokens = totalTokens / 2;
  const input = (inputTokens / 1_000_000) * inputCost * usd2cny;
  const output = (outputTokens / 1_000_000) * outputCost * usd2cny;
  return input + output;
}

export default function BepAnalysisPage() {
  // 2025年ARPU为0.2元，默认月增长率2%，增长率上限30%
  const [arpu0, setArpu0] = useState(0.2);
  const [monthGrowth, setMonthGrowth] = useState(0.02);
  const [growthCap, setGrowthCap] = useState(0.3);

  // 计算每月ARPU（复利增长，增长率逐步提升到上限）
  let currentArpu = arpu0;
  let currentGrowth = monthGrowth;
  const arpuArr: string[] = [];
  for (let i = 0; i < months.length; i++) {
    currentArpu = currentArpu * (1 + currentGrowth);
    if (currentGrowth < growthCap) {
      currentGrowth = Math.min(currentGrowth + 0.001, growthCap);
    }
    arpuArr.push(currentArpu.toFixed(4));
  }

  // 平滑插值每月推理成本
  const steps = months.length;
  const inputCosts = Array.from({ length: steps }, (_, i) => interpolateGeometric(inputCostStart, inputCostEnd, steps, i));
  const outputCosts = Array.from({ length: steps }, (_, i) => interpolateGeometric(outputCostStart, outputCostEnd, steps, i));

  // 计算每月推理成本（每天2小时，平滑插值）
  const costArr = months.map((_, i) => calcDayCost(inputCosts[i], outputCosts[i], 2).toFixed(4));
  // 盈亏差额
  const diffArr = months.map((_, i) => (parseFloat(arpuArr[i]) - parseFloat(costArr[i])).toFixed(4));

  const chartOption = {
    title: {
      text: "2025-2026.5猫箱app单用户每日收入与推理成本对比",
      left: "center",
    },
    tooltip: {
      trigger: "axis",
      formatter: (params: { axisValue: string; seriesName: string; data: string }[]) => {
        let s = `<b>${params[0].axisValue}</b><br/>`;
        params.forEach((p) => {
          s += `${p.seriesName}: <b>¥${p.data}</b><br/>`;
        });
        return s;
      },
    },
    legend: {
      data: ["推理成本", "实际收入(ARPU)", "盈亏差额"],
      top: 30,
    },
    xAxis: {
      type: "category",
      data: months,
      name: "月份",
    },
    yAxis: {
      type: "value",
      name: "元/人/天",
      min: 0,
    },
    series: [
      {
        name: "推理成本",
        type: "line",
        data: costArr,
        smooth: true,
        symbol: "circle",
        lineStyle: { color: "#2563eb" },
        itemStyle: { color: "#2563eb" },
      },
      {
        name: "实际收入(ARPU)",
        type: "line",
        data: arpuArr,
        smooth: true,
        symbol: "circle",
        lineStyle: { color: "#16a34a" },
        itemStyle: { color: "#16a34a" },
      },
      {
        name: "盈亏差额",
        type: "bar",
        data: diffArr,
        yAxisIndex: 0,
        itemStyle: { color: "#f59e42" },
      },
    ],
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">猫箱app商业化盈亏分析（2025-2026.5）</h1>
      <div className="mb-4 text-lg">假设AI陪伴型产品，每人每天2小时推理，2025年ARPU为0.2元，后续逐月递增，增长率逐步提升到上限。推理成本按等比递减平滑过渡。</div>
      <div className="mb-4 flex items-center space-x-4">
        <label>2025年起始ARPU（元/天/人）：</label>
        <input type="number" min={0.01} step={0.01} value={arpu0} onChange={e => setArpu0(Number(e.target.value))} className="border rounded px-2 py-1 w-24" />
        <label>月增长率：</label>
        <input type="number" min={0} max={1} step={0.001} value={monthGrowth} onChange={e => setMonthGrowth(Number(e.target.value))} className="border rounded px-2 py-1 w-20" />
        <span className="text-gray-500">（如0.02代表2%）</span>
        <label>增长率上限：</label>
        <input type="number" min={0} max={1} step={0.001} value={growthCap} onChange={e => setGrowthCap(Number(e.target.value))} className="border rounded px-2 py-1 w-20" />
        <span className="text-gray-500">（如0.3代表30%）</span>
      </div>
      <ReactECharts option={chartOption} style={{ height: 400 }} />
      <table className="w-full border mt-8 text-center">
        <thead>
          <tr className="bg-gray-100">
            <th className="border px-4 py-2">月份</th>
            <th className="border px-4 py-2">推理成本（元/天/人）</th>
            <th className="border px-4 py-2">实际收入（ARPU）</th>
            <th className="border px-4 py-2">盈亏差额</th>
          </tr>
        </thead>
        <tbody>
          {months.map((month, i) => (
            <tr key={month}>
              <td className="border px-4 py-2">{month}</td>
              <td className="border px-4 py-2">¥{costArr[i]}</td>
              <td className="border px-4 py-2">¥{arpuArr[i]}</td>
              <td className="border px-4 py-2" style={{color: parseFloat(diffArr[i]) >= 0 ? '#16a34a' : '#dc2626'}}>{diffArr[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 text-gray-500 text-sm">推理成本按每天2小时，输入输出token各占一半，成本数据2025-2026年等比递减插值，汇率按1美元=7.2元人民币。</div>
    </div>
  );
} 
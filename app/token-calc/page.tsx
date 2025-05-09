"use client";
import React from "react";
import ReactECharts from "echarts-for-react";

// 2023~2030年每百万token成本预测（美元）
const years = [2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030];
const inputCosts = [30, 5, 1.25, 0.3, 0.125, 0.03, 0.01, 0.005];
const outputCosts = [60, 15, 5, 1.25, 0.6, 0.175, 0.1, 0.05];
const usd2cny = 7.2;
const tokensPerHour = 100_000;
const daysPerYear = 365;

function calcDayCost(inputCost: number, outputCost: number, hoursPerDay: number) {
  const totalTokens = tokensPerHour * hoursPerDay;
  const inputTokens = totalTokens / 2;
  const outputTokens = totalTokens / 2;
  const input = (inputTokens / 1_000_000) * inputCost * usd2cny;
  const output = (outputTokens / 1_000_000) * outputCost * usd2cny;
  return input + output;
}

const cost1h = years.map((_, i) => calcDayCost(inputCosts[i], outputCosts[i], 1).toFixed(2));
const cost2h = years.map((_, i) => calcDayCost(inputCosts[i], outputCosts[i], 2).toFixed(2));
const yearCost1h = years.map((_, i) => (parseFloat(cost1h[i]) * daysPerYear).toFixed(2));
const yearCost2h = years.map((_, i) => (parseFloat(cost2h[i]) * daysPerYear).toFixed(2));

const chartOptionDay = {
  title: {
    text: "2023-2030年高频用户每天消耗大模型成本（人民币）",
    left: "center",
  },
  tooltip: {
    trigger: "axis",
    formatter: (params: { axisValue: string; seriesName: string; data: string }[]) => {
      let s = `<b>${params[0].axisValue}年</b><br/>`;
      params.forEach((p) => {
        s += `${p.seriesName}: <b>¥${p.data}</b><br/>`;
      });
      return s;
    },
  },
  legend: {
    data: ["每天1小时", "每天2小时"],
    top: 30,
  },
  xAxis: {
    type: "category",
    data: years,
    name: "年份",
  },
  yAxis: {
    type: "value",
    name: "每天成本（元）",
    min: 0,
  },
  series: [
    {
      name: "每天1小时",
      type: "line",
      data: cost1h,
      smooth: true,
      symbol: "circle",
      lineStyle: { color: "#2563eb" },
      itemStyle: { color: "#2563eb" },
    },
    {
      name: "每天2小时",
      type: "line",
      data: cost2h,
      smooth: true,
      symbol: "circle",
      lineStyle: { color: "#16a34a" },
      itemStyle: { color: "#16a34a" },
    },
  ],
};

const chartOptionYear = {
  title: {
    text: "2023-2030年高频用户年总成本（人民币）",
    left: "center",
  },
  tooltip: {
    trigger: "axis",
    formatter: (params: { axisValue: string; seriesName: string; data: string }[]) => {
      let s = `<b>${params[0].axisValue}年</b><br/>`;
      params.forEach((p) => {
        s += `${p.seriesName}: <b>¥${p.data}</b><br/>`;
      });
      return s;
    },
  },
  legend: {
    data: ["每天1小时", "每天2小时"],
    top: 30,
  },
  xAxis: {
    type: "category",
    data: years,
    name: "年份",
  },
  yAxis: {
    type: "value",
    name: "年总成本（元）",
    min: 0,
  },
  series: [
    {
      name: "每天1小时",
      type: "line",
      data: yearCost1h,
      smooth: true,
      symbol: "circle",
      lineStyle: { color: "#2563eb" },
      itemStyle: { color: "#2563eb" },
    },
    {
      name: "每天2小时",
      type: "line",
      data: yearCost2h,
      smooth: true,
      symbol: "circle",
      lineStyle: { color: "#16a34a" },
      itemStyle: { color: "#16a34a" },
    },
  ],
};

const tableData = years.map((year, i) => {
  return {
    year,
    day1h: cost1h[i],
    day2h: cost2h[i],
    year1h: yearCost1h[i],
    year2h: yearCost2h[i],
  };
});

export default function TokenCalcPage() {
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">2023-2030年高频用户大模型成本分析（人民币）</h1>
      <div className="mb-4 text-lg">假设高频用户每小时消耗 <b>100,000</b> token，分别计算每天1小时和2小时的每日成本与年总成本。</div>
      <table className="w-full border mb-8 text-center">
        <thead>
          <tr className="bg-gray-100">
            <th className="border px-4 py-2">年份</th>
            <th className="border px-4 py-2">每天1小时/日成本</th>
            <th className="border px-4 py-2">每天2小时/日成本</th>
            <th className="border px-4 py-2">每天1小时/年总成本</th>
            <th className="border px-4 py-2">每天2小时/年总成本</th>
          </tr>
        </thead>
        <tbody>
          {tableData.map(row => (
            <tr key={row.year}>
              <td className="border px-4 py-2">{row.year}</td>
              <td className="border px-4 py-2">¥{row.day1h}</td>
              <td className="border px-4 py-2">¥{row.day2h}</td>
              <td className="border px-4 py-2">¥{row.year1h}</td>
              <td className="border px-4 py-2">¥{row.year2h}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ReactECharts option={chartOptionDay} style={{ height: 400 }} />
      <div className="mt-8" />
      <ReactECharts option={chartOptionYear} style={{ height: 400 }} />
      <div className="mt-4 text-gray-500 text-sm">假设输入输出token各占一半，成本数据参考2023-2030年预测，汇率按1美元=7.2元人民币。</div>
    </div>
  );
} 
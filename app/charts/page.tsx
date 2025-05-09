"use client";
import React from "react";
import ReactECharts from "echarts-for-react";

const years = [
  "2023",
  "2024",
  "2025",
  "2026",
  "2027",
  "2028",
  "2029",
  "2030",
];

// 2023: 输入30，输出60；2024: 输入5，输出15；2025及后用原有预测，2029年补全为0.015和0.1
const inputCost = [30, 5, 1.25, 0.3, 0.125, 0.03, 0.015, 0.005];
const outputCost = [60, 15, 5, 1.25, 0.6, 0.175, 0.1, 0.05];

const costOption = {
  title: {
    text: "大模型每百万token成本预测（2023-2030，美元）",
    left: "center",
  },
  tooltip: {
    trigger: "axis",
  },
  legend: {
    data: ["输入成本", "输出成本"],
    top: 30,
  },
  xAxis: {
    type: "category",
    data: years,
  },
  yAxis: {
    type: "value",
    name: "美元/百万token",
    min: 0,
    max: 65,
  },
  series: [
    {
      name: "输入成本",
      type: "line",
      data: inputCost,
      connectNulls: true,
      smooth: true,
      symbol: "circle",
    },
    {
      name: "输出成本",
      type: "line",
      data: outputCost,
      connectNulls: true,
      smooth: true,
      symbol: "circle",
    },
  ],
};

export default function ChartsPage() {
  return (
    <div className="p-8 space-y-8">
      <h1 className="text-2xl font-bold mb-4">折线图演示</h1>
      <ReactECharts option={costOption} style={{ height: 400 }} />
      <table className="w-full border mt-8 text-center">
        <thead>
          <tr className="bg-gray-100">
            <th className="border px-4 py-2">年份</th>
            <th className="border px-4 py-2">输入成本（美元/百万token）</th>
            <th className="border px-4 py-2">输出成本（美元/百万token）</th>
          </tr>
        </thead>
        <tbody>
          {years.map((year, i) => (
            <tr key={year}>
              <td className="border px-4 py-2">{year}</td>
              <td className="border px-4 py-2">{inputCost[i] !== null ? inputCost[i] : '-'}</td>
              <td className="border px-4 py-2">{outputCost[i] !== null ? outputCost[i] : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
} 
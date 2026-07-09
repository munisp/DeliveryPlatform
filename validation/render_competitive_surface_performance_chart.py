from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt

BASE = Path('/home/ubuntu/merged_switchos_project_v2/validation')
metrics = json.loads((BASE / 'competitive_surface_performance_metrics.json').read_text())

series = [
    ('TypeScript workspace', metrics['typescript_workspace']),
    ('TypeScript concierge', metrics['typescript_concierge']),
    ('Python forecast', metrics['python_forecast']),
    ('Rust allocation', metrics['rust_allocation']),
    ('Go gateway', metrics['go_gateway']),
    ('End-to-end concierge', metrics['end_to_end_concierge']),
]

labels = [name for name, _ in series]
avg = [item['avg_ms'] for _, item in series]
p95 = [item['p95_ms'] for _, item in series]
median = [item['median_ms'] for _, item in series]

plt.style.use('seaborn-v0_8-whitegrid')
fig, ax = plt.subplots(figsize=(12, 6))
x = range(len(labels))
width = 0.24
ax.bar([i - width for i in x], median, width=width, label='Median (ms)', color='#4C78A8')
ax.bar(x, avg, width=width, label='Average (ms)', color='#F58518')
ax.bar([i + width for i in x], p95, width=width, label='P95 (ms)', color='#54A24B')
ax.set_xticks(list(x))
ax.set_xticklabels(labels, rotation=20, ha='right')
ax.set_ylabel('Latency (ms)')
ax.set_title('Competitive Upgrade Surface Latency Comparison')
ax.legend()
for idx, value in enumerate(avg):
    ax.text(idx, value + 0.2, f'{value:.2f}', ha='center', va='bottom', fontsize=8)
fig.tight_layout()
out = BASE / 'competitive_surface_performance_chart.png'
fig.savefig(out, dpi=180)
print(out)

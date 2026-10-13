import json
import uuid

def panel_number(name, metric, time_agg="avg", space_agg="sum", reduce_to="last", unit="none", precision="0", filter_expr=""):
    pid = str(uuid.uuid4())
    p = {
        "kind": "Panel",
        "spec": {
            "display": {"name": name, "description": ""},
            "plugin": {
                "kind": "signoz/NumberPanel",
                "spec": {
                    "visualization": {"timePreference": "global_time"},
                    "formatting": {"unit": unit, "decimalPrecision": precision},
                    "thresholds": None
                }
            },
            "queries": [
                {
                    "kind": "scalar",
                    "spec": {
                        "plugin": {
                            "kind": "signoz/CompositeQuery",
                            "spec": {
                                "queries": [
                                    {
                                        "type": "builder_query",
                                        "spec": {
                                            "name": "A",
                                            "stepInterval": 60,
                                            "signal": "metrics",
                                            "source": "",
                                            "aggregations": [
                                                {
                                                    "metricName": metric,
                                                    "temporality": "",
                                                    "timeAggregation": time_agg,
                                                    "spaceAggregation": space_agg,
                                                    "reduceTo": reduce_to
                                                }
                                            ],
                                            "disabled": False,
                                            "filter": {"expression": filter_expr},
                                            "groupBy": [],
                                            "order": [],
                                            "having": {"expression": ""},
                                            "functions": [],
                                            "legend": "{{name}}"
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            ]
        }
    }
    return pid, p

def panel_timeseries(name, queries_def, unit="none", precision="2", fill="none"):
    pid = str(uuid.uuid4())
    b_queries = []
    for q in queries_def:
        b_queries.append({
            "type": "builder_query",
            "spec": {
                "name": q["name"],
                "stepInterval": 60,
                "signal": "metrics",
                "source": "",
                "aggregations": [
                    {
                        "metricName": q["metric"],
                        "temporality": "",
                        "timeAggregation": q.get("time_agg", "rate"),
                        "spaceAggregation": q.get("space_agg", "sum"),
                        "reduceTo": "avg"
                    }
                ],
                "disabled": False,
                "filter": {"expression": q.get("filter", "")},
                "groupBy": q.get("group_by", []),
                "order": [],
                "having": {"expression": ""},
                "functions": [],
                "legend": q.get("legend", "")
            }
        })

    p = {
        "kind": "Panel",
        "spec": {
            "display": {"name": name, "description": ""},
            "plugin": {
                "kind": "signoz/TimeSeriesPanel",
                "spec": {
                    "visualization": {"timePreference": "global_time", "fillSpans": False},
                    "formatting": {"unit": unit, "decimalPrecision": precision},
                    "chartAppearance": {
                        "lineInterpolation": "spline",
                        "showPoints": False,
                        "lineStyle": "solid",
                        "fillMode": fill,
                        "spanGaps": {"fillOnlyBelow": False, "fillLessThan": ""}
                    },
                    "axes": {"softMin": None, "softMax": None, "isLogScale": False},
                    "legend": {"position": "bottom", "mode": "list", "customColors": None},
                    "thresholds": None
                }
            },
            "queries": [
                {
                    "kind": "time_series",
                    "spec": {
                        "plugin": {
                            "kind": "signoz/CompositeQuery",
                            "spec": {
                                "queries": b_queries
                            }
                        }
                    }
                }
            ]
        }
    }
    return pid, p

def panel_table(name, queries_def, precision="2"):
    pid = str(uuid.uuid4())
    b_queries = []
    for q in queries_def:
        b_queries.append({
            "type": "builder_query",
            "spec": {
                "name": q["name"],
                "stepInterval": 60,
                "signal": "metrics",
                "source": "",
                "aggregations": [
                    {
                        "metricName": q["metric"],
                        "temporality": "",
                        "timeAggregation": q.get("time_agg", "avg"),
                        "spaceAggregation": q.get("space_agg", "sum"),
                        "reduceTo": "last"
                    }
                ],
                "disabled": False,
                "filter": {"expression": q.get("filter", "")},
                "groupBy": q.get("group_by", []),
                "order": [],
                "having": {"expression": ""},
                "functions": [],
                "legend": q.get("legend", "")
            }
        })

    p = {
        "kind": "Panel",
        "spec": {
            "display": {"name": name, "description": ""},
            "plugin": {
                "kind": "signoz/TablePanel",
                "spec": {
                    "visualization": {"timePreference": "global_time"},
                    "formatting": {"columnUnits": {}, "decimalPrecision": precision},
                    "thresholds": None
                }
            },
            "queries": [
                {
                    "kind": "scalar",
                    "spec": {
                        "plugin": {
                            "kind": "signoz/CompositeQuery",
                            "spec": {
                                "queries": b_queries
                            }
                        }
                    }
                }
            ]
        }
    }
    return pid, p

panels = {}
items = []
current_y = 0

# Row 1: KPI Summary Row
kpi1_id, kpi1 = panel_number("Active Connections", "postgresql.backends", "avg", "sum", "last", "none", "0", "host.name = 'postgres-origin-svc'")
kpi2_id, kpi2 = panel_number("Committed Txns / sec", "postgresql.commits", "rate", "sum", "avg", "reqps", "2", "host.name = 'postgres-origin-svc'")
kpi3_id, kpi3 = panel_number("Row Operations / sec", "postgresql.operations", "rate", "sum", "avg", "ops", "2", "host.name = 'postgres-origin-svc'")
kpi4_id, kpi4 = panel_number("Deadlocks Count", "postgresql.deadlocks", "avg", "sum", "last", "none", "0", "host.name = 'postgres-origin-svc'")

panels[kpi1_id] = kpi1
panels[kpi2_id] = kpi2
panels[kpi3_id] = kpi3
panels[kpi4_id] = kpi4

items.append({"x": 0, "y": current_y, "width": 3, "height": 3, "content": {"$ref": f"#/spec/panels/{kpi1_id}"}})
items.append({"x": 3, "y": current_y, "width": 3, "height": 3, "content": {"$ref": f"#/spec/panels/{kpi2_id}"}})
items.append({"x": 6, "y": current_y, "width": 3, "height": 3, "content": {"$ref": f"#/spec/panels/{kpi3_id}"}})
items.append({"x": 9, "y": current_y, "width": 3, "height": 3, "content": {"$ref": f"#/spec/panels/{kpi4_id}"}})
current_y += 3

# Row 2: Throughput & Operations Time Series
ts1_id, ts1 = panel_timeseries(
    "DML Operations Rate (per second)",
    [{
        "name": "A",
        "metric": "postgresql.operations",
        "time_agg": "rate",
        "space_agg": "sum",
        "filter": "host.name = 'postgres-origin-svc'",
        "group_by": [{"name": "operation", "signal": "", "fieldContext": "attribute", "fieldDataType": "string"}],
        "legend": "{{operation}}"
    }],
    unit="ops",
    precision="2",
    fill="none"
)

ts2_id, ts2 = panel_timeseries(
    "Transactions (Commits vs Rollbacks / sec)",
    [
        {
            "name": "A",
            "metric": "postgresql.commits",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Commits/sec"
        },
        {
            "name": "B",
            "metric": "postgresql.rollbacks",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Rollbacks/sec"
        }
    ],
    unit="reqps",
    precision="2"
)

panels[ts1_id] = ts1
panels[ts2_id] = ts2
items.append({"x": 0, "y": current_y, "width": 6, "height": 4, "content": {"$ref": f"#/spec/panels/{ts1_id}"}})
items.append({"x": 6, "y": current_y, "width": 6, "height": 4, "content": {"$ref": f"#/spec/panels/{ts2_id}"}})
current_y += 4

# Row 3: Performance & Cache Efficiency
ts3_id, ts3 = panel_timeseries(
    "Buffer Cache Hits vs Disk Reads / sec",
    [
        {
            "name": "A",
            "metric": "postgresql.blks_hit",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Cache Hits (Memory)"
        },
        {
            "name": "B",
            "metric": "postgresql.blks_read",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Disk Reads (I/O)"
        }
    ],
    unit="ops",
    precision="2"
)

ts4_id, ts4 = panel_timeseries(
    "Index Scans vs Sequential Scans / sec (Missing Index Detector)",
    [
        {
            "name": "A",
            "metric": "postgresql.index.scans",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Index Scans"
        },
        {
            "name": "B",
            "metric": "postgresql.sequential_scans",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Sequential Scans (SeqScan)"
        }
    ],
    unit="ops",
    precision="2"
)

panels[ts3_id] = ts3
panels[ts4_id] = ts4
items.append({"x": 0, "y": current_y, "width": 6, "height": 4, "content": {"$ref": f"#/spec/panels/{ts3_id}"}})
items.append({"x": 6, "y": current_y, "width": 6, "height": 4, "content": {"$ref": f"#/spec/panels/{ts4_id}"}})
current_y += 4

# Row 4: Locks by Mode & Tuples Throughput
ts5_id, ts5 = panel_timeseries(
    "Active Locks by Mode",
    [{
        "name": "A",
        "metric": "postgresql.database.locks",
        "time_agg": "avg",
        "space_agg": "sum",
        "filter": "host.name = 'postgres-origin-svc'",
        "group_by": [{"name": "mode", "signal": "", "fieldContext": "attribute", "fieldDataType": "string"}],
        "legend": "{{mode}}"
    }],
    unit="none",
    precision="0"
)

ts6_id, ts6 = panel_timeseries(
    "Tuples Activity (Fetched vs Returned vs Modified / sec)",
    [
        {
            "name": "A",
            "metric": "postgresql.tup_fetched",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Tuples Fetched"
        },
        {
            "name": "B",
            "metric": "postgresql.tup_returned",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Tuples Returned"
        },
        {
            "name": "C",
            "metric": "postgresql.tup_inserted",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Tuples Inserted"
        },
        {
            "name": "D",
            "metric": "postgresql.tup_updated",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Tuples Updated"
        }
    ],
    unit="ops",
    precision="2"
)

panels[ts5_id] = ts5
panels[ts6_id] = ts6
items.append({"x": 0, "y": current_y, "width": 6, "height": 4, "content": {"$ref": f"#/spec/panels/{ts5_id}"}})
items.append({"x": 6, "y": current_y, "width": 6, "height": 4, "content": {"$ref": f"#/spec/panels/{ts6_id}"}})
current_y += 4

# Row 5: PgCache / Dragonfly Query Engine Acceleration
ts7_id, ts7 = panel_timeseries(
    "PgCache / Dragonfly Acceleration (Cache Hits vs Misses / sec)",
    [
        {
            "name": "A",
            "metric": "pgcache_queries_cache_hit",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "",
            "group_by": [],
            "legend": "Cache Hits (L1/L2 Fast Path)"
        },
        {
            "name": "B",
            "metric": "pgcache_queries_cache_miss",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "",
            "group_by": [],
            "legend": "Cache Misses (Origin Path)"
        }
    ],
    unit="ops",
    precision="2"
)

ts8_id, ts8 = panel_timeseries(
    "BgWriter Checkpoints & Buffer Activity / sec",
    [
        {
            "name": "A",
            "metric": "postgresql.bgwriter.checkpoint.count",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Checkpoints/sec"
        },
        {
            "name": "B",
            "metric": "postgresql.bgwriter.buffers.writes",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Buffer Writes/sec"
        },
        {
            "name": "C",
            "metric": "postgresql.bgwriter.buffers.allocated",
            "time_agg": "rate",
            "space_agg": "sum",
            "filter": "host.name = 'postgres-origin-svc'",
            "group_by": [],
            "legend": "Buffer Allocations/sec"
        }
    ],
    unit="ops",
    precision="2"
)

panels[ts7_id] = ts7
panels[ts8_id] = ts8
items.append({"x": 0, "y": current_y, "width": 6, "height": 4, "content": {"$ref": f"#/spec/panels/{ts7_id}"}})
items.append({"x": 6, "y": current_y, "width": 6, "height": 4, "content": {"$ref": f"#/spec/panels/{ts8_id}"}})
current_y += 4

# Row 6: Tables and Index Sizes
tbl1_id, tbl1 = panel_table(
    "Top Tables by Disk Size",
    [{
        "name": "A",
        "metric": "postgresql.table.size",
        "time_agg": "avg",
        "space_agg": "sum",
        "filter": "host.name = 'postgres-origin-svc'",
        "group_by": [{"name": "postgresql.table.name", "signal": "", "fieldContext": "attribute", "fieldDataType": "string"}],
        "legend": "{{postgresql.table.name}}"
    }],
    precision="0"
)

tbl2_id, tbl2 = panel_table(
    "Top Indexes by Disk Size",
    [{
        "name": "A",
        "metric": "postgresql.index.size",
        "time_agg": "avg",
        "space_agg": "sum",
        "filter": "host.name = 'postgres-origin-svc'",
        "group_by": [{"name": "postgresql.index.name", "signal": "", "fieldContext": "attribute", "fieldDataType": "string"}],
        "legend": "{{postgresql.index.name}}"
    }],
    precision="0"
)

panels[tbl1_id] = tbl1
panels[tbl2_id] = tbl2
items.append({"x": 0, "y": current_y, "width": 6, "height": 5, "content": {"$ref": f"#/spec/panels/{tbl1_id}"}})
items.append({"x": 6, "y": current_y, "width": 6, "height": 5, "content": {"$ref": f"#/spec/panels/{tbl2_id}"}})
current_y += 5

dashboard = {
    "name": "postgresql-18-database-overview-of1n1fcb",
    "schemaVersion": "v6",
    "image": "",
        "tags": [{"key": "tag", "value": "postgres"}, {"key": "tag", "value": "production"}, {"key": "tag", "value": "datadog-grade"}],
    "spec": {
        "display": {
            "name": "PostgreSQL 18 - Enterprise Deep Monitoring",
            "description": "Painel de alta fidelidade para PostgreSQL 18 Origin + PgCache: Throughput DML/seg, QPS, TPS, Detecção de SeqScans, Eficiência de Cache em Memória, Locks e BgWriter."
        },
        "variables": [
            {
                "kind": "ListVariable",
                "spec": {
                    "display": {"name": "host.name", "description": "Host Postgres"},
                    "allowAllValue": True,
                    "allowMultiple": True,
                    "defaultValue": ["postgres-origin-svc"],
                    "customAllValue": "",
                    "capturingRegexp": "",
                    "sort": "alphabetical-asc",
                    "plugin": {
                        "kind": "signoz/DynamicVariable",
                        "spec": {"name": "host.name", "signal": "metrics"}
                    },
                    "name": "host.name"
                }
            }
        ],
        "panels": panels,
        "layouts": [{"kind": "Grid", "spec": {"items": items}}],
        "duration": "30m",
        "refreshInterval": "15s",
        "links": []
    }
}

with open("infra/charts/slack-suite/files/dashboards/postgresql-database-overview.json", "w") as f:
    json.dump(dashboard, f, indent=2)

print(f"Generated dashboard with {len(panels)} panels successfully!")

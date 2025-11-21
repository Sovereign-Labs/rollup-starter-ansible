# Monitoring

This document describes how to monitor Sovereign Rollup node. 
Currently there are 2 monitoring sub-systems:

1. High precision data using InfluxDB
2. Aggregated data using Prometheus

## High precision metrics via InfluxDB and Telegraf 

Sovereign Rollup utilizes InfluxDB as storage for detailed metrics.

This Ansible deployment script expects to have InfluxDB v2 up and running.

The next section describes how to run it in AWS. If there's already an InfluxDB available, skip to the [Ansible setup](#ansible-setup) section.

### Run InfluxDB using Amazon Timestream

This section describes how to set up an InfluxDB database in [Amazon Teimstream](https://aws.amazon.com/timestream/).

This is a shorter version of the preferred [official guide](https://docs.aws.amazon.com/timestream/latest/developerguide/timestream-for-influx-getting-started-creating-db-instance.html).

***CLI: For non-publicly accessible instance***

0. Create a security group which will allow connections to port 8086 from any IP in the VPC where the EC2 instance is going to be run.
1.Go to "Timestream" service page
2. Click on "InfluxDB databases".
3. Click on "Create InlfluxDB" database.
4. Fill in credential values. For staging or testing, it is recommended to have "db.influx.medium", allocated storage 100GB, and Single-AZ availability. Make it non-publicly accessible and assign the group created at step 0. 
5. [Install influx-cli](https://docs.influxdata.com/influxdb/v2/tools/influx-cli/?t=Linux) on the EC2 instance where the rollup is going to be run.
6. On the Database details page, copy the "Endpoint value". The URL needed in the next step is going to have the format: "https://ENDPOINT:8086".
7. After the database status changes from "Creating" to "Available", SSH into the EC2 instance where `influx` CLI is installed.
8. Create a config:
    ```
    influx config create \
        --config-name CONFIG_SOV_ROLLUP \
        --host-url "https://ENDPOINT:8086" \
        --org YOUR_ORG \
         --username-password YOUR_USERNAME \
         --active
    ```
8. Create all-access API token:
    ```
    ./influx auth create \
            --host="https://ENDPOINT:8086"" \
            --org=YOUR_ORG \
            --all-access
    ```

This token will be used in the Ansible setup.

***Web UI: For publicly accessible instance***

0. Create a security group which will allow connections to port 8086 from **your IP address** and from any IP in the VPC where the EC2 instance is going to be run.
1. Go to "Timestream" service page
2. Click on "InfluxDB databases".
3. Click on "Create InlfluxDB" database.
4. Fill in credential values. For staging or testing, it is recommended to have "db.influx.medium", allocated storage 100GB, and Single-AZ availability. Make it publicly accessible and assign the group created at step 0.
5. After the database is created, log in to InfluxUI. From there go to "Load data" -> "API tokens" section and generate an all-access token.
6. On the AWS Timestream Database details page, copy the "Endpoint value". The URL needed in the next step is going to have the format: "https://ENDPOINT:8086".

The result of this step should be a running InfluxDB instance and credentials needed for the Ansible setup.

### Ansible setup

At this point, the InfluxDB instance should be up and running and should be accessible from the host where the rollup node is supposed to run.

It can be validated by querying the ping endpoint:

```bash
curl -v  https://ENDPOINT:8086/ping
```

Fill `influxdb_org`, `influxdb_remote_url` and `influxdb_bucket` in [`roles/common/defaults/main.yaml`](./roles/common/defaults/main.yaml)

Please make sure that the bucket and organization exist in InfluxDB.

Fill variable `influxdb_token` with API Token for accessing influxDB in [`vars/telegra_secrets.yaml`](./vars/monitoring_secrets.yaml)

### Grafana Dashboard

After InfluxDB is connected to your Grafana instance, you can import dashboards that are available in [`dasboards`](./dashboards).

## Aggregated metrics via Prometheus

This datasource in considered to be deprecated in the future. Currently, the only metrics not provided by InfluxDB are rocksdb related data.


## How to debug metrics

### InfluxDB

In order to see metrics from rollup node in grafana, data flows following way:

`Rollup binary -> Telegraf Service -> InfluxDB -> Grafana`

If data is missing in Grafana dashboard

 * Enable trace logging for metrics by adding `sov_metrics=trace` to the `RUST_LOG` environment variable. 
   This can be added to the [`rollup.sh`](./roles/rollup/templates/rollup.sh.j2) script, like so: `export RUST_LOG=debug,sov_metrics=trace`. It will show if metrics are being submitted.
   It will show if metrics are being submitted.
 * Make sure `rollup_config.toml` has proper configuration values for the Telegraf service in `[monitoring]` section.
 * Check telegraf service logs: `journalctl -u telegraf`. It should show metrics are being submitted. Make sure it writes to the correct bucket and API token.
 * Log in to the InfluxDB UI, go to "Data Explorer", and verify that data is there.
 * MMake sure the data source connection is correct in Grafana.

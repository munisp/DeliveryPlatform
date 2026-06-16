"""
Lakehouse Event Connector
Streams events from Kafka to Delta Lake for analytics and ML training
"""
import os
import json
from datetime import datetime
from typing import Dict, Any, List
from kafka import KafkaConsumer
from delta import DeltaTable, configure_spark_with_delta_pip
from pyspark.sql import SparkSession
from pyspark.sql.types import StructType, StructField, StringType, DoubleType, TimestampType, IntegerType
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Delta Lake configuration
DELTA_LAKE_PATH = os.getenv("DELTA_LAKE_PATH", "/data/lakehouse")
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")

# Initialize Spark with Delta Lake
builder = (
    SparkSession.builder
    .appName("SwitchOS Lakehouse Connector")
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
    .config("spark.driver.memory", "2g")
    .config("spark.executor.memory", "2g")
)

spark = configure_spark_with_delta_pip(builder).getOrCreate()
spark.sparkContext.setLogLevel("WARN")

# Define schemas for different event types
ORDER_SCHEMA = StructType([
    StructField("event_id", StringType(), False),
    StructField("event_type", StringType(), False),
    StructField("timestamp", TimestampType(), False),
    StructField("order_id", StringType(), False),
    StructField("order_number", StringType(), True),
    StructField("customer_id", StringType(), True),
    StructField("vertical_id", StringType(), True),
    StructField("provider_id", StringType(), True),
    StructField("driver_id", StringType(), True),
    StructField("status", StringType(), True),
    StructField("total_amount", DoubleType(), True),
    StructField("platform_fee", DoubleType(), True),
    StructField("driver_fee", DoubleType(), True),
    StructField("pickup_latitude", DoubleType(), True),
    StructField("pickup_longitude", DoubleType(), True),
    StructField("delivery_latitude", DoubleType(), True),
    StructField("delivery_longitude", DoubleType(), True),
    StructField("scheduled_pickup_time", TimestampType(), True),
    StructField("actual_pickup_time", TimestampType(), True),
    StructField("actual_delivery_time", TimestampType(), True),
    StructField("estimated_delivery_time", TimestampType(), True),
])

DRIVER_SCHEMA = StructType([
    StructField("event_id", StringType(), False),
    StructField("event_type", StringType(), False),
    StructField("timestamp", TimestampType(), False),
    StructField("driver_id", StringType(), False),
    StructField("name", StringType(), True),
    StructField("status", StringType(), True),
    StructField("vehicle_type", StringType(), True),
    StructField("current_latitude", DoubleType(), True),
    StructField("current_longitude", DoubleType(), True),
    StructField("rating", DoubleType(), True),
    StructField("total_orders", IntegerType(), True),
])

PAYMENT_SCHEMA = StructType([
    StructField("event_id", StringType(), False),
    StructField("event_type", StringType(), False),
    StructField("timestamp", TimestampType(), False),
    StructField("payment_id", StringType(), False),
    StructField("order_id", StringType(), True),
    StructField("customer_id", StringType(), True),
    StructField("amount", DoubleType(), True),
    StructField("currency", StringType(), True),
    StructField("payment_method", StringType(), True),
    StructField("status", StringType(), True),
    StructField("provider", StringType(), True),
    StructField("transaction_id", StringType(), True),
])

class LakehouseConnector:
    def __init__(self):
        self.consumers = {}
        self.table_paths = {
            "orders": f"{DELTA_LAKE_PATH}/orders",
            "drivers": f"{DELTA_LAKE_PATH}/drivers",
            "payments": f"{DELTA_LAKE_PATH}/payments",
        }
        self.schemas = {
            "orders": ORDER_SCHEMA,
            "drivers": DRIVER_SCHEMA,
            "payments": PAYMENT_SCHEMA,
        }
        self.initialize_tables()
    
    def initialize_tables(self):
        """Initialize Delta Lake tables if they don't exist"""
        for table_name, table_path in self.table_paths.items():
            try:
                # Try to load existing table
                DeltaTable.forPath(spark, table_path)
                logger.info(f"Table {table_name} already exists at {table_path}")
            except Exception:
                # Create new table
                schema = self.schemas[table_name]
                df = spark.createDataFrame([], schema)
                df.write.format("delta").mode("overwrite").save(table_path)
                logger.info(f"Created new Delta table {table_name} at {table_path}")
    
    def create_consumer(self, topic: str, group_id: str) -> KafkaConsumer:
        """Create Kafka consumer for a specific topic"""
        consumer = KafkaConsumer(
            topic,
            bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
            group_id=group_id,
            value_deserializer=lambda m: json.loads(m.decode('utf-8')),
            auto_offset_reset='earliest',
            enable_auto_commit=True,
        )
        self.consumers[topic] = consumer
        return consumer
    
    def process_order_events(self):
        """Process order creation/update events"""
        consumer = self.create_consumer("order-events", "lakehouse-order-consumer")
        logger.info("Started consuming order events...")
        
        batch = []
        batch_size = 100
        
        for message in consumer:
            try:
                event = message.value
                
                # Transform event to match schema
                row = {
                    "event_id": event.get("eventId", ""),
                    "event_type": event.get("eventType", ""),
                    "timestamp": datetime.fromisoformat(event.get("timestamp", datetime.now().isoformat())),
                    "order_id": event.get("orderId", ""),
                    "order_number": event.get("orderNumber"),
                    "customer_id": event.get("customerId"),
                    "vertical_id": event.get("verticalId"),
                    "provider_id": event.get("providerId"),
                    "driver_id": event.get("driverId"),
                    "status": event.get("status"),
                    "total_amount": event.get("totalAmount"),
                    "platform_fee": event.get("platformFee"),
                    "driver_fee": event.get("driverFee"),
                    "pickup_latitude": event.get("pickupLatitude"),
                    "pickup_longitude": event.get("pickupLongitude"),
                    "delivery_latitude": event.get("deliveryLatitude"),
                    "delivery_longitude": event.get("deliveryLongitude"),
                    "scheduled_pickup_time": datetime.fromisoformat(event["scheduledPickupTime"]) if event.get("scheduledPickupTime") else None,
                    "actual_pickup_time": datetime.fromisoformat(event["actualPickupTime"]) if event.get("actualPickupTime") else None,
                    "actual_delivery_time": datetime.fromisoformat(event["actualDeliveryTime"]) if event.get("actualDeliveryTime") else None,
                    "estimated_delivery_time": datetime.fromisoformat(event["estimatedDeliveryTime"]) if event.get("estimatedDeliveryTime") else None,
                }
                
                batch.append(row)
                
                # Write batch to Delta Lake
                if len(batch) >= batch_size:
                    self.write_batch("orders", batch)
                    batch = []
                    
            except Exception as e:
                logger.error(f"Error processing order event: {e}")
    
    def process_driver_events(self):
        """Process driver location/status events"""
        consumer = self.create_consumer("driver-events", "lakehouse-driver-consumer")
        logger.info("Started consuming driver events...")
        
        batch = []
        batch_size = 100
        
        for message in consumer:
            try:
                event = message.value
                
                row = {
                    "event_id": event.get("eventId", ""),
                    "event_type": event.get("eventType", ""),
                    "timestamp": datetime.fromisoformat(event.get("timestamp", datetime.now().isoformat())),
                    "driver_id": event.get("driverId", ""),
                    "name": event.get("name"),
                    "status": event.get("status"),
                    "vehicle_type": event.get("vehicleType"),
                    "current_latitude": event.get("currentLatitude"),
                    "current_longitude": event.get("currentLongitude"),
                    "rating": event.get("rating"),
                    "total_orders": event.get("totalOrders"),
                }
                
                batch.append(row)
                
                if len(batch) >= batch_size:
                    self.write_batch("drivers", batch)
                    batch = []
                    
            except Exception as e:
                logger.error(f"Error processing driver event: {e}")
    
    def process_payment_events(self):
        """Process payment transaction events"""
        consumer = self.create_consumer("payment-events", "lakehouse-payment-consumer")
        logger.info("Started consuming payment events...")
        
        batch = []
        batch_size = 100
        
        for message in consumer:
            try:
                event = message.value
                
                row = {
                    "event_id": event.get("eventId", ""),
                    "event_type": event.get("eventType", ""),
                    "timestamp": datetime.fromisoformat(event.get("timestamp", datetime.now().isoformat())),
                    "payment_id": event.get("paymentId", ""),
                    "order_id": event.get("orderId"),
                    "customer_id": event.get("customerId"),
                    "amount": event.get("amount"),
                    "currency": event.get("currency"),
                    "payment_method": event.get("paymentMethod"),
                    "status": event.get("status"),
                    "provider": event.get("provider"),
                    "transaction_id": event.get("transactionId"),
                }
                
                batch.append(row)
                
                if len(batch) >= batch_size:
                    self.write_batch("payments", batch)
                    batch = []
                    
            except Exception as e:
                logger.error(f"Error processing payment event: {e}")
    
    def write_batch(self, table_name: str, batch: List[Dict[str, Any]]):
        """Write batch of events to Delta Lake"""
        try:
            schema = self.schemas[table_name]
            df = spark.createDataFrame(batch, schema)
            
            # Partition by date for efficient querying
            df = df.withColumn("date", df["timestamp"].cast("date"))
            
            table_path = self.table_paths[table_name]
            df.write.format("delta").mode("append").partitionBy("date").save(table_path)
            
            logger.info(f"Wrote {len(batch)} events to {table_name} table")
            
        except Exception as e:
            logger.error(f"Error writing batch to {table_name}: {e}")
    
    def optimize_tables(self):
        """Optimize Delta tables (compaction and Z-ordering)"""
        for table_name, table_path in self.table_paths.items():
            try:
                delta_table = DeltaTable.forPath(spark, table_path)
                
                # Compact small files
                delta_table.optimize().executeCompaction()
                
                # Z-order by commonly queried columns
                if table_name == "orders":
                    delta_table.optimize().executeZOrderBy("order_id", "customer_id", "status")
                elif table_name == "drivers":
                    delta_table.optimize().executeZOrderBy("driver_id", "status")
                elif table_name == "payments":
                    delta_table.optimize().executeZOrderBy("payment_id", "order_id", "status")
                
                logger.info(f"Optimized {table_name} table")
                
            except Exception as e:
                logger.error(f"Error optimizing {table_name}: {e}")
    
    def vacuum_tables(self, retention_hours: int = 168):
        """Remove old files (default: 7 days retention)"""
        for table_name, table_path in self.table_paths.items():
            try:
                delta_table = DeltaTable.forPath(spark, table_path)
                delta_table.vacuum(retention_hours)
                logger.info(f"Vacuumed {table_name} table")
            except Exception as e:
                logger.error(f"Error vacuuming {table_name}: {e}")
    
    def get_table_stats(self, table_name: str) -> Dict[str, Any]:
        """Get statistics for a Delta table"""
        try:
            table_path = self.table_paths[table_name]
            df = spark.read.format("delta").load(table_path)
            
            return {
                "table_name": table_name,
                "total_rows": df.count(),
                "schema": df.schema.json(),
                "partitions": df.select("date").distinct().count(),
            }
        except Exception as e:
            logger.error(f"Error getting stats for {table_name}: {e}")
            return {}

if __name__ == "__main__":
    connector = LakehouseConnector()
    
    # Start consuming events from all topics
    import threading
    
    threads = [
        threading.Thread(target=connector.process_order_events, daemon=True),
        threading.Thread(target=connector.process_driver_events, daemon=True),
        threading.Thread(target=connector.process_payment_events, daemon=True),
    ]
    
    for thread in threads:
        thread.start()
    
    logger.info("Lakehouse connector started. Processing events...")
    
    # Keep main thread alive
    for thread in threads:
        thread.join()

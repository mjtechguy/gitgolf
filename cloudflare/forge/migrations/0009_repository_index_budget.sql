CREATE TABLE repository_index_budget (
  day TEXT PRIMARY KEY, operations INTEGER NOT NULL CHECK(operations BETWEEN 0 AND 60000)
);

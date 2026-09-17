const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'links.db');

function migrateDatabase() {
  const db = new Database(DB_PATH);

  // foreign_keys must stay disabled for this connection while rebuilding the table
  db.pragma('foreign_keys = OFF');

  try {
    const tableInfo = db.pragma("table_info(links)");
    const columns = tableInfo.map(col => col.name);

    // Rebuild the links table to add http_status/check_error columns and allow
    // the 'failed' status (timeout / refused, as opposed to confirmed 'dead').
    // http_status only exists in the new schema, so its absence marks a legacy table.
    if (!columns.includes('http_status')) {
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE links_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            category_id INTEGER,
            status TEXT DEFAULT 'unchecked' CHECK(status IN ('alive', 'dead', 'failed', 'unchecked')),
            http_status INTEGER,
            check_error TEXT,
            last_checked DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_read_later INTEGER DEFAULT 0,
            review_date DATETIME,
            review_status TEXT DEFAULT 'pending' CHECK(review_status IN ('pending', 'completed', 'skipped')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
          );

          INSERT INTO links_new
            (id, user_id, url, title, description, category_id, status, last_checked,
             created_at, is_read_later, review_date, review_status)
          SELECT id, user_id, url, title, description, category_id, status, last_checked,
                 created_at, is_read_later, review_date, review_status
          FROM links;

          DROP TABLE links;
          ALTER TABLE links_new RENAME TO links;

          CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
          CREATE INDEX IF NOT EXISTS idx_links_category_id ON links(category_id);
        `);
      });
      rebuild();
      console.log('Rebuilt links table with http_status/check_error columns and failed status');
    }

    // Safety net for older databases that predate the read-later feature
    const refreshedInfo = db.pragma("table_info(links)");
    const refreshedColumns = refreshedInfo.map(col => col.name);

    if (!refreshedColumns.includes('is_read_later')) {
      db.exec('ALTER TABLE links ADD COLUMN is_read_later INTEGER DEFAULT 0');
      console.log('Added column: is_read_later');
    }

    if (!refreshedColumns.includes('review_date')) {
      db.exec('ALTER TABLE links ADD COLUMN review_date DATETIME');
      console.log('Added column: review_date');
    }

    if (!refreshedColumns.includes('review_status')) {
      db.exec("ALTER TABLE links ADD COLUMN review_status TEXT DEFAULT 'pending' CHECK(review_status IN ('pending', 'completed', 'skipped'))");
      console.log('Added column: review_status');
    }

    // Recreate the indexes that originally lived outside the table definition,
    // in case the rebuild above ran against a database that had them.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_link_tags_link_id ON link_tags(link_id);
      CREATE INDEX IF NOT EXISTS idx_link_tags_tag ON link_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
    `);

    console.log('Database migration completed successfully');
  } catch (error) {
    console.error('Migration error:', error);
  } finally {
    db.pragma('foreign_keys = ON');
    db.close();
  }
}

module.exports = { migrateDatabase };

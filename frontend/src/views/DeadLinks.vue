<template>
  <div class="dead-links-container">
    <el-card>
      <template #header>
        <div class="card-header">
          <el-button @click="$router.push('/')" text>
            <el-icon><ArrowLeft /></el-icon>
            返回
          </el-button>
          <h2>死链检测</h2>
          <el-button
            v-if="summary.total > 0"
            type="primary"
            :loading="checking"
            :disabled="checking"
            @click="handleCheckAll"
          >
            <el-icon><Refresh /></el-icon>
            检测所有链接
          </el-button>
        </div>
      </template>

      <!-- 空态：一条链接都还没有 -->
      <el-empty v-if="summary.total === 0" description="还没有收藏任何链接，无法进行检测">
        <el-button type="primary" @click="$router.push('/')">先去添加链接</el-button>
      </el-empty>

      <template v-else>
        <!-- 检测进度 -->
        <div v-if="checking" class="checking-progress">
          <el-icon class="is-loading" :size="24"><Loading /></el-icon>
          <p>正在检测第 {{ checkedCount + 1 }} / {{ totalToCheck }} 条，还剩 {{ totalToCheck - checkedCount }} 条</p>
          <el-progress :percentage="progress" />
          <el-button class="cancel-button" type="warning" plain @click="handleCancel">中断检测</el-button>
        </div>

        <!-- 本次检测结论 -->
        <el-alert
          v-if="lastRun && !checking"
          class="run-result"
          :type="lastRun.cancelled ? 'warning' : 'success'"
          :closable="false"
          :title="lastRun.cancelled
            ? `检测已中断：本次已检测 ${lastRun.checked} 条（${lastRun.alive} 条正常，${lastRun.dead} 条失效），剩余 ${lastRun.remaining} 条未检测，已判定的结果已保留`
            : `检测完成：共检测 ${lastRun.checked} 条，${lastRun.alive} 条正常，${lastRun.dead} 条失效`"
        />

        <!-- 总体计数（来自数据库，刷新/返回后保持一致） -->
        <div class="summary-bar">
          <el-tag>共 {{ summary.total }} 条</el-tag>
          <el-tag type="success">正常 {{ summary.alive }}</el-tag>
          <el-tag type="danger">失效 {{ summary.dead }}</el-tag>
          <el-tag type="info">未检测 {{ summary.unchecked }}</el-tag>
        </div>

        <div v-if="deadLinks.length > 0" class="dead-links-list">
          <h3>失效链接列表</h3>
          <el-table
            :data="deadLinks"
            stripe
            border
            :default-sort="defaultSort"
            @sort-change="handleSortChange"
            @header-dragend="handleHeaderDragend"
          >
            <el-table-column prop="title" label="标题" min-width="150" sortable resizable :width="columnWidths.title" />
            <el-table-column prop="url" label="URL" min-width="250" sortable resizable :width="columnWidths.url">
              <template #default="{ row }">
                <a :href="row.url" target="_blank" class="url-link">{{ row.url }}</a>
              </template>
            </el-table-column>
            <el-table-column prop="category_name" label="分类" width="120" sortable resizable :width="columnWidths.category_name">
              <template #default="{ row }">
                <el-tag v-if="row.category_name" :color="row.category_color" effect="dark" size="small">
                  {{ row.category_name }}
                </el-tag>
                <span v-else class="no-category">未分类</span>
              </template>
            </el-table-column>
            <el-table-column prop="last_checked" label="检测时间" width="180" sortable resizable :width="columnWidths.last_checked">
              <template #default="{ row }">
                {{ formatDate(row.last_checked) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="160" resizable :width="columnWidths.action">
              <template #default="{ row }">
                <el-button
                  type="primary"
                  size="small"
                  plain
                  :loading="retryingId === row.id"
                  :disabled="checking"
                  @click="handleRetry(row)"
                >重试</el-button>
                <el-button type="danger" size="small" :disabled="checking" @click="handleDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <el-empty v-else description="没有失效的链接" />
      </template>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { healthCheckApi, linksApi } from '../api'

const SORT_STORAGE_KEY = 'deadlinks.table.sort'
const WIDTHS_STORAGE_KEY = 'deadlinks.table.widths'

const checking = ref(false)
const checkedCount = ref(0)
const totalToCheck = ref(0)
const cancelRequested = ref(false)
const lastRun = ref(null)
const summary = ref({ total: 0, alive: 0, dead: 0, unchecked: 0 })
const deadLinks = ref([])
const retryingId = ref(null)

// 表格排序与列宽持久化，刷新后保持用户调整过的状态
const defaultSort = ref(loadJson(SORT_STORAGE_KEY) || { prop: 'last_checked', order: 'descending' })
const columnWidths = ref(loadJson(WIDTHS_STORAGE_KEY) || {})

const progress = computed(() => {
  if (totalToCheck.value === 0) return 0
  return Math.round((checkedCount.value / totalToCheck.value) * 100)
})

onMounted(() => {
  refreshData()
})

function loadJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function refreshData() {
  try {
    const [summaryRes, deadRes] = await Promise.all([
      healthCheckApi.getSummary(),
      healthCheckApi.getDeadLinks(),
    ])
    summary.value = summaryRes.data
    deadLinks.value = deadRes.data
  } catch (err) {
    console.error('Failed to fetch health check data:', err)
  }
}

async function handleCheckAll() {
  let targets
  try {
    const response = await healthCheckApi.getTargets()
    targets = response.data
  } catch (err) {
    ElMessage.error('获取待检测链接失败')
    return
  }

  if (targets.length === 0) {
    ElMessage.info('没有需要检测的链接')
    return
  }

  checking.value = true
  cancelRequested.value = false
  checkedCount.value = 0
  totalToCheck.value = targets.length
  lastRun.value = null

  const run = { checked: 0, alive: 0, dead: 0, cancelled: false, remaining: 0 }

  // 逐条检测，每条结果立即落库；中断后已判定的保留，未检测的维持原样
  for (const target of targets) {
    if (cancelRequested.value) {
      run.cancelled = true
      break
    }
    try {
      const response = await healthCheckApi.checkLink(target.id)
      if (response.data.status === 'alive') run.alive += 1
      else run.dead += 1
    } catch (err) {
      // 单条请求失败不中断整批，按失效计入
      run.dead += 1
    }
    run.checked += 1
    checkedCount.value = run.checked
  }

  run.remaining = targets.length - run.checked
  lastRun.value = run
  checking.value = false

  await refreshData()
  ElMessage[run.cancelled ? 'warning' : 'success'](run.cancelled ? '检测已中断' : '检测完成')
}

function handleCancel() {
  cancelRequested.value = true
}

async function handleRetry(link) {
  retryingId.value = link.id
  try {
    const response = await healthCheckApi.checkLink(link.id)
    if (response.data.status === 'alive') {
      ElMessage.success(`"${link.title}" 已恢复正常`)
    } else {
      ElMessage.warning(`"${link.title}" 仍然无法访问`)
    }
    await refreshData()
  } catch (err) {
    ElMessage.error('重试失败，请稍后再试')
  } finally {
    retryingId.value = null
  }
}

async function handleDelete(link) {
  try {
    await ElMessageBox.confirm(`确定要删除 "${link.title}" 吗？`, '确认删除', {
      type: 'warning',
    })
    await linksApi.deleteLink(link.id)
    await refreshData()
    ElMessage.success('删除成功')
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

function handleSortChange({ prop, order }) {
  if (order) {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ prop, order }))
  } else {
    localStorage.removeItem(SORT_STORAGE_KEY)
  }
}

function handleHeaderDragend(newWidth, oldWidth, column) {
  const key = column.property || 'action'
  columnWidths.value = { ...columnWidths.value, [key]: newWidth }
  localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths.value))
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN')
}
</script>

<style scoped>
.dead-links-container {
  max-width: 1100px;
  margin: 40px auto;
  padding: 0 20px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.card-header h2 {
  margin: 0;
  flex: 1;
}

.checking-progress {
  text-align: center;
  padding: 40px 0;
}

.checking-progress p {
  margin: 16px 0;
  color: #606266;
}

.checking-progress .el-progress {
  max-width: 400px;
  margin: 0 auto;
}

.cancel-button {
  margin-top: 16px;
}

.run-result {
  margin-bottom: 16px;
}

.summary-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.dead-links-list {
  margin-top: 24px;
}

.dead-links-list h3 {
  margin: 0 0 16px 0;
  color: #303133;
}

.url-link {
  color: #409eff;
  text-decoration: none;
  word-break: break-all;
  font-size: 13px;
}

.url-link:hover {
  text-decoration: underline;
}

.no-category {
  color: #909399;
  font-size: 13px;
}
</style>

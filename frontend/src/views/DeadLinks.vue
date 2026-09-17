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
            type="primary"
            :disabled="checking || links.length === 0"
            @click="handleCheckAll(false)"
          >
            <el-icon><VideoPlay /></el-icon>
            {{ hasUnresolved ? '检测未完成链接' : '开始检测' }}
          </el-button>
          <el-button
            :disabled="checking || links.length === 0"
            @click="handleCheckAll(true)"
          >
            <el-icon><Refresh /></el-icon>
            全部重新检测
          </el-button>
        </div>
      </template>

      <!-- 加载中骨架 -->
      <el-skeleton v-if="loading" :rows="6" animated />

      <!-- 一条链接都没有：明确的空态，引导先去添加 -->
      <el-empty v-else-if="links.length === 0" description="还没有保存任何链接，暂无可检测对象">
        <el-button type="primary" @click="goAddLink">
          <el-icon><Plus /></el-icon>
          先去添加链接
        </el-button>
      </el-empty>

      <template v-else>
        <!-- 检测进行中：显示查到第几条 / 剩余多少，可中途中断 -->
        <div v-if="checking" class="checking-progress">
          <div class="progress-title">
            <el-icon class="is-loading" :size="22"><Loading /></el-icon>
            <span>
              正在检测第 {{ Math.min(doneCount + 1, totalToCheck) }} / {{ totalToCheck }} 条，
              还剩 {{ totalToCheck - doneCount }} 条
            </span>
            <el-button type="danger" plain size="small" @click="cancelCheck">
              <el-icon><VideoPause /></el-icon>
              中断检测
            </el-button>
          </div>
          <el-progress :percentage="progressPercent" />
          <p class="progress-current">当前：{{ checkingUrl || '准备中…' }}</p>
        </div>

        <!-- 结论与计数：来自数据库，离开页面再回来保持一致 -->
        <div v-if="counts.total > 0 && !checking" class="summary-bar">
          <el-tag size="large" type="success" effect="plain">正常 {{ counts.alive }}</el-tag>
          <el-tag size="large" type="danger" effect="plain">失效 {{ counts.dead }}</el-tag>
          <el-tag size="large" type="warning" effect="plain">检测失败 {{ counts.failed }}</el-tag>
          <el-tag size="large" type="info" effect="plain">未检测 {{ counts.unchecked }}</el-tag>
          <span class="summary-total">共 {{ counts.total }} 条</span>
        </div>

        <el-radio-group v-model="filter" size="small" class="filter-tabs">
          <el-radio-button value="all">全部 ({{ counts.total }})</el-radio-button>
          <el-radio-button value="dead">失效 ({{ counts.dead }})</el-radio-button>
          <el-radio-button value="failed">检测失败 ({{ counts.failed }})</el-radio-button>
          <el-radio-button value="alive">正常 ({{ counts.alive }})</el-radio-button>
          <el-radio-button value="unchecked">未检测 ({{ counts.unchecked }})</el-radio-button>
        </el-radio-group>

        <el-table
          :data="filteredLinks"
          stripe
          border
          :default-sort="sortState"
          @sort-change="handleSortChange"
          @header-dragend="handleHeaderDragEnd"
          class="links-table"
        >
          <el-table-column
            prop="title"
            label="标题"
            sortable="custom"
            :width="colWidths.title"
          />
          <el-table-column prop="url" label="URL" sortable="custom" :width="colWidths.url">
            <template #default="{ row }">
              <a :href="row.url" target="_blank" class="url-link">{{ row.url }}</a>
            </template>
          </el-table-column>
          <el-table-column
            prop="status"
            label="状态"
            width="130"
            sortable="custom"
          >
            <template #default="{ row }">
              <el-tag v-if="row.id === checkingId" type="info" size="small">
                <el-icon class="is-loading rotating"><Loading /></el-icon>
                检测中
              </el-tag>
              <el-tag v-else-if="row.status === 'alive'" type="success" size="small">正常</el-tag>
              <el-tag v-else-if="row.status === 'dead'" type="danger" size="small">失效</el-tag>
              <el-tooltip
                v-else-if="row.status === 'failed'"
                :content="failureReason(row)"
                placement="top"
                :disabled="!row.check_error"
              >
                <el-tag type="warning" size="small">检测失败</el-tag>
              </el-tooltip>
              <el-tag v-else type="info" size="small">未检测</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="category_name" label="分类" width="120" sortable="custom">
            <template #default="{ row }">
              <el-tag v-if="row.category_name" :color="row.category_color" effect="dark" size="small">
                {{ row.category_name }}
              </el-tag>
              <span v-else class="no-category">未分类</span>
            </template>
          </el-table-column>
          <el-table-column
            prop="last_checked"
            label="检测时间"
            :width="colWidths.last_checked"
            sortable="custom"
          >
            <template #default="{ row }">
              {{ formatDate(row.last_checked) }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'failed'"
                type="primary"
                link
                size="small"
                :loading="row.id === checkingId"
                @click="handleRetry(row)"
              >
                重试
              </el-button>
              <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :description="filterEmptyText" :image-size="80" />
          </template>
        </el-table>
      </template>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessageBox, ElMessage } from 'element-plus'
import { healthCheckApi, linksApi } from '../api'

const router = useRouter()

const PREF_SORT_KEY = 'deadLinks:sort'
const PREF_COLWIDTH_KEY = 'deadLinks:colWidths'

const DEFAULT_COL_WIDTHS = { title: 180, url: 280, last_checked: 180 }

const loading = ref(true)
const links = ref([])
const counts = ref({ total: 0, alive: 0, dead: 0, failed: 0, unchecked: 0 })
const filter = ref('all')

// Batch-check progress
const checking = ref(false)
const checkingId = ref(null)
const checkingUrl = ref('')
const doneCount = ref(0)
const totalToCheck = ref(0)
let cancelRequested = false

const hasUnresolved = computed(
  () => counts.value.unchecked > 0 || counts.value.failed > 0
)

const progressPercent = computed(() => {
  if (totalToCheck.value === 0) return 0
  return Math.round((doneCount.value / totalToCheck.value) * 100)
})

// Sort + column width preferences (survive refresh)
const sortState = ref(loadSort())
const colWidths = ref({ ...DEFAULT_COL_WIDTHS, ...loadColWidths() })

function loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_SORT_KEY))
    if (saved && saved.prop) return saved
  } catch (e) {
    // ignore malformed preference
  }
  return { prop: 'last_checked', order: 'descending' }
}

function loadColWidths() {
  try {
    return JSON.parse(localStorage.getItem(PREF_COLWIDTH_KEY)) || {}
  } catch (e) {
    return {}
  }
}

const filteredLinks = computed(() => {
  let rows = links.value
  if (filter.value !== 'all') {
    rows = rows.filter((l) => l.status === filter.value)
  }
  return sortRows(rows, sortState.value)
})

// Client-side sort driven by the persisted sort state.
function sortRows(rows, { prop, order }) {
  if (!prop || !order) return rows
  const factor = order === 'ascending' ? 1 : -1
  return [...rows].sort((a, b) => {
    let va = a[prop]
    let vb = b[prop]
    if (prop === 'last_checked') {
      // Never-checked rows sink to the bottom regardless of direction
      if (!va && !vb) return 0
      if (!va) return 1
      if (!vb) return -1
      va = new Date(va).getTime()
      vb = new Date(vb).getTime()
    } else {
      va = (va ?? '').toString().toLowerCase()
      vb = (vb ?? '').toString().toLowerCase()
    }
    if (va < vb) return -1 * factor
    if (va > vb) return 1 * factor
    return 0
  })
}

const filterEmptyText = computed(() => {
  const map = {
    all: '暂无链接',
    dead: '没有失效的链接',
    failed: '没有检测失败的链接',
    alive: '没有状态正常的链接',
    unchecked: '所有链接都已检测',
  }
  return map[filter.value]
})

function failureReason(row) {
  if (row.check_error === 'Timeout') return '请求超时，可单独重试'
  if (row.check_error) return `检测失败：${row.check_error}`
  return '检测失败，可单独重试'
}

function handleSortChange({ prop, order }) {
  // Clicking the active sort header a third time clears order; fall back to default.
  sortState.value = order ? { prop, order } : { prop: 'last_checked', order: 'descending' }
  localStorage.setItem(PREF_SORT_KEY, JSON.stringify(sortState.value))
}

function handleHeaderDragEnd(newWidth, _oldWidth, column) {
  const key = column.property
  if (!key || !(key in DEFAULT_COL_WIDTHS)) return
  colWidths.value = { ...colWidths.value, [key]: newWidth }
  localStorage.setItem(PREF_COLWIDTH_KEY, JSON.stringify(colWidths.value))
}

async function fetchStatus() {
  loading.value = true
  try {
    const { data } = await healthCheckApi.getStatus()
    counts.value = data.counts
    links.value = data.links
  } catch (err) {
    console.error('Failed to fetch check status:', err)
    ElMessage.error('加载检测状态失败')
  } finally {
    loading.value = false
  }
}

function patchLink(updated) {
  const idx = links.value.findIndex((l) => l.id === updated.id)
  if (idx !== -1) {
    links.value[idx] = { ...links.value[idx], ...updated }
  }
  recomputeCounts()
}

function recomputeCounts() {
  const next = { total: links.value.length, alive: 0, dead: 0, failed: 0, unchecked: 0 }
  links.value.forEach((l) => {
    next[l.status] = (next[l.status] || 0) + 1
  })
  counts.value = next
}

// Check a single link. Network/timeout failures isolate to this one row
// and never abort the surrounding batch. Returns the new status, or null when
// no verdict came back.
async function checkOne(link, { silent = false } = {}) {
  checkingId.value = link.id
  checkingUrl.value = link.url
  try {
    const { data } = await healthCheckApi.checkOne(link.id)
    patchLink({
      id: link.id,
      status: data.status,
      http_status: data.http_status,
      check_error: data.error,
      last_checked: new Date().toISOString(),
    })
    return data.status
  } catch (err) {
    // Request never produced a verdict (network error / 5xx / abort):
    // leave the row's existing status untouched.
    if (!silent) {
      ElMessage.warning(`「${link.title}」本次请求未完成，可稍后单独重试`)
    }
    return null
  } finally {
    checkingId.value = null
    checkingUrl.value = ''
  }
}

// recheckAll=false: only unchecked + previously failed links
// recheckAll=true:  every link
async function handleCheckAll(recheckAll) {
  const targets = links.value.filter(
    (l) => recheckAll || l.status === 'unchecked' || l.status === 'failed'
  )
  if (targets.length === 0) {
    ElMessage.info('没有需要检测的链接')
    return
  }

  checking.value = true
  cancelRequested = false
  totalToCheck.value = targets.length
  doneCount.value = 0

  let okCount = 0
  for (const link of targets) {
    if (cancelRequested) break
    // eslint-disable-next-line no-await-in-loop
    if ((await checkOne(link, { silent: true })) !== null) okCount += 1
    doneCount.value += 1
  }

  const interrupted = cancelRequested
  checking.value = false

  // Re-sync with the server so conclusions/counts are exactly what is stored.
  await fetchStatus()

  if (interrupted) {
    ElMessage.info(`已中断：已判定的 ${okCount} 条结果已保留，未检测的链接维持原样`)
  } else if (counts.value.failed > 0) {
    ElMessage.warning(`检测完成：${counts.value.dead} 条失效，${counts.value.failed} 条检测失败，可对失败项单独重试`)
  } else {
    ElMessage.success(`检测完成：${counts.value.alive} 条正常，${counts.value.dead} 条失效`)
  }
}

function cancelCheck() {
  cancelRequested = true
}

async function handleRetry(link) {
  const newStatus = await checkOne(link)
  if (newStatus === null) return
  recomputeCounts()
  if (newStatus === 'alive') {
    ElMessage.success(`「${link.title}」重试通过，链接正常`)
  } else if (newStatus === 'dead') {
    ElMessage.warning(`「${link.title}」重试后仍为失效链接`)
  } else {
    ElMessage.warning(`「${link.title}」仍然检测失败，请稍后再试`)
  }
}

async function handleDelete(link) {
  try {
    await ElMessageBox.confirm(`确定要删除 "${link.title}" 吗？`, '确认删除', {
      type: 'warning',
    })
    await linksApi.deleteLink(link.id)
    links.value = links.value.filter((l) => l.id !== link.id)
    recomputeCounts()
    ElMessage.success('删除成功')
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

function goAddLink() {
  router.push({ path: '/', query: { add: '1' } })
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN')
}

// Leaving the page mid-check should not leave an orphaned loop running.
onBeforeUnmount(() => {
  cancelRequested = true
})

onMounted(() => {
  fetchStatus()
})
</script>

<style scoped>
.dead-links-container {
  max-width: 1200px;
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
  padding: 20px;
  margin-bottom: 20px;
  background: #f4f8ff;
  border-radius: 6px;
}

.progress-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #303133;
  margin-bottom: 14px;
}

.progress-title .el-button {
  margin-left: auto;
}

.progress-current {
  margin: 10px 0 0;
  color: #909399;
  font-size: 13px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.summary-total {
  margin-left: auto;
  color: #909399;
  font-size: 13px;
}

.filter-tabs {
  margin-bottom: 16px;
}

.links-table {
  width: 100%;
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

.rotating {
  animation: rotating 1.2s linear infinite;
}

@keyframes rotating {
  from {
    transform: rotate(0);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>

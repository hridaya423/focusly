const CONSTANTS = {
  IDLE_THRESHOLD: 5 * 60 * 1000,
  HISTORY_RETENTION_DAYS: 30,
  MIN_LOG_TIME: 1000,
  DEBOUNCE_DELAY: 1000,
  CHART_COLORS: [
    '#4CAF50', '#2196F3', '#FFC107', '#9C27B0', '#F44336',
    '#009688', '#673AB7', '#FF5722', '#795548', '#607D8B'
  ]
};

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function formatTime(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function parseTimeToMs(timeStr) {
  const hours = timeStr.match(/(\d+)h/);
  const minutes = timeStr.match(/(\d+)m/);
  return (hours ? parseInt(hours[1]) * 3600000 : 0) + 
         (minutes ? parseInt(minutes[1]) * 60000 : 0);
  }

class StorageManager {
  static async get(key) {
    try {
      const data = await chrome.storage.local.get(key);
      return data[key];
    } catch (error) {
      console.error('Storage get error:', error);
      return null;
    }
  }

  static async set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      return true;
    } catch (error) {
      console.error('Storage set error:', error);
      return false;
    }
  }

  static async updateHistory(date, domain, timeSpent) {
    const data = await this.get('browsingHistory') || {};
    if (!data[date]) data[date] = {};
    data[date][domain] = (data[date][domain] || 0) + timeSpent;
    return this.set('browsingHistory', data);
  }

  static async cleanOldHistory() {
    const history = await this.get('browsingHistory') || {};
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - CONSTANTS.HISTORY_RETENTION_DAYS);
    
    Object.keys(history).forEach(date => {
      if (new Date(date) < thirtyDaysAgo) {
        delete history[date];
      }
    });
    
    return this.set('browsingHistory', history);
  }
}

class BrowsingStats {
  constructor() {
    this.chart = null;
    this.currentPeriod = 'day';
    this.currentData = null;
    this.productivityCategories = {
      productive: [],
      neutral: [],
      distracting: []
    };
    this.loadProductivitySettings();
    this.initializeEventListeners();
  }

  async loadProductivitySettings() {
    const settings = await StorageManager.get('settings')
    if (settings?.productivityCategories) {
      this.productivityCategories = settings.productivityCategories;
    }
  }

  initializeEventListeners() {
    document.getElementById('openOptionsBtn')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    document.querySelectorAll('.time-filter button').forEach(button => {
      button.addEventListener('click', this.handleFilterClick.bind(this));
    });
    
    document.querySelectorAll('.view-toggle button').forEach(button => {
      button.addEventListener('click', this.handleViewToggle.bind(this));
    });
    document.querySelector('.close-btn')?.addEventListener('click', () => this.closeModal());
    document.querySelector('.view-all-btn')?.addEventListener('click', () => this.showDetailedView());
    document.querySelector('.search-input')?.addEventListener('input', (e) => this.handleSearch(e));
    document.querySelector('.time-filter select')?.addEventListener('change', (e) => this.handleTimeFilter(e));

    document.querySelector('.export-btn')?.addEventListener('click', () => this.exportData());
  }

  async handleFilterClick(event) {
    const buttons = document.querySelectorAll('.time-filter button');
    buttons.forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    this.currentPeriod = event.target.dataset.period;
    await this.displayStats();
  }

  handleViewToggle(event) {
    const buttons = document.querySelectorAll('.view-toggle button');
    buttons.forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    
    const view = event.target.dataset.view;
    document.getElementById('chartView').classList.toggle('hidden', view !== 'chart');
    document.getElementById('listView').classList.toggle('hidden', view !== 'list');

    if (view === 'chart' && this.currentData) {
      this.updateChart(this.currentData);
    }
  }

  async getHistoryData(period = 'day') {
    const history = await StorageManager.get('browsingHistory') || {};
    const endDate = new Date();
    const startDate = new Date();
    
    switch(period) {
      case 'week':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate.setDate(startDate.getDate() - 30);
        break;
      case 'day':
        startDate.setHours(0, 0, 0, 0);
        break;
    }

    const aggregatedData = {};
    let currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      const dayData = history[dateStr] || {};
      
      Object.entries(dayData).forEach(([domain, time]) => {
        aggregatedData[domain] = (aggregatedData[domain] || 0) + time;
      });
      
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return aggregatedData;
  }

  async displayStats() {
    try {
      const data = await this.getHistoryData(this.currentPeriod);
      
      if (Object.keys(data).length === 0) {
        this.showNoDataMessage();
        return;
      }

      this.currentData = data;
      const filteredData = this.filterLowTimeEntries(data, 60000);
      
      this.updateStatCards(data);
      this.updateChart(filteredData);
      this.updateTable(filteredData);
      
      this.fullData = data;
    } catch (error) {
      console.error('Error displaying stats:', error);
      this.showErrorMessage(error);
    }
  }

  showNoDataMessage() {
    const containers = ['chartView', 'listView'];
    containers.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        element.innerHTML = `
          <div class="no-data">
            <div class="no-data-icon">📊</div>
            <div class="no-data-text">Welcome to Focusly!</div>
            <div class="no-data-subtext">Start browsing to see your statistics</div>
          </div>
        `;
      }
    });
  }

  showErrorMessage(error) {
      const chartView = document.getElementById('chartView');
      if (chartView) {
        chartView.innerHTML = `
          <div class="error-message">
            <div class="error-icon">⚠️</div>
            <div class="error-text">Error loading data</div>
            <div class="error-subtext">${error.message}</div>
          </div>
        `;
      }
    }

    updateStatCards(data) {
      try {
        const totalMs = Object.values(data).reduce((sum, time) => sum + time, 0);
        const sortedSites = Object.entries(data).sort((a, b) => b[1] - a[1]);
        
        ['totalTime', 'topSite', 'siteCount', 'productivity'].forEach(id => {
          const element = document.getElementById(id);
          if (!element) {
            console.error(`Element not found: ${id}`);
            return;
          }
          
          if (id === 'totalTime') element.textContent = formatTime(totalMs);
          else if (id === 'topSite') element.textContent = sortedSites.length > 0 ? sortedSites[0][0].replace('www.', '') : '-';
          else if (id === 'siteCount') element.textContent = Object.keys(data).length;
          else if (id === 'productivity') element.textContent = `${this.calculateProductivityScore(data)}%`;
        });
      } catch (error) {
        console.error('updateStatCards error:', error);
        throw error;
      }
    }

  calculateProductivityScore(data) {
    let productiveTime = 0;
    let distractingTime = 0;
    let totalTime = 0;

    Object.entries(data).forEach(([domain, time]) => {
      totalTime += time;
      if (this.productivityCategories.productive.some(pd => domain.includes(pd))) {
        productiveTime += time;
      } else if (this.productivityCategories.distracting.some(dd => domain.includes(dd))) {
        distractingTime += time;
      }
    });

    if (totalTime === 0) return 0;
    return Math.round(((productiveTime - distractingTime) / totalTime) * 100);
  }

  

  updateChart(data) {
      const canvas = document.getElementById('browsingChart');
      if (!canvas) {
        console.error('Chart canvas not found');
        return;
      }
      
      if (this.chart) {
        this.chart.destroy();
        this.chart = null;
      }
      
      const newCanvas = document.createElement('canvas');
      newCanvas.id = 'browsingChart';
      canvas.parentNode.replaceChild(newCanvas, canvas);
      
      const ctx = newCanvas.getContext('2d');
      
      if (typeof Chart === 'undefined') {
        console.error('Chart.js not loaded');
        return;
      }

    const sortedEntries = Object.entries(data).sort((a, b) => b[1] - a[1]);
    const topSites = sortedEntries.slice(0, 5);
    const otherSites = sortedEntries.slice(5);

    const chartData = {
      labels: [...topSites.map(([domain]) => domain.replace('www.', '')), 
               otherSites.length ? 'Others' : null].filter(Boolean),
      datasets: [{
        data: [...topSites.map(([_, time]) => Math.round(time / 60000)), 
               otherSites.length ? Math.round(otherSites.reduce((sum, [_, time]) => sum + time, 0) / 60000) : null]
               .filter(Boolean),
        backgroundColor: [
          '#4CAF50', '#2196F3', '#FFC107', '#9C27B0', '#F44336',
          '#757575'
        ]
      }]
    };

    this.chart = new Chart(ctx, {
      type: 'doughnut',
      data: chartData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              boxWidth: 12,
              padding: 15
            }
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const label = context.label || '';
                const value = context.raw || 0;
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const percentage = ((value / total) * 100).toFixed(1);
                return `${label}: ${formatTime(value * 60000)} (${percentage}%)`;
              }
            }
          }
        },
        cutout: '60%'
      }
    });
  }

  updateTable(data) {
    const totalTime = Object.values(data).reduce((sum, time) => sum + time, 0);
    const sortedEntries = Object.entries(data)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const table = document.getElementById('summaryTable').getElementsByTagName('tbody')[0];
    table.innerHTML = sortedEntries
      .map(([domain, time]) => `
        <tr>
          <td>
            <div class="domain-cell">
              <span class="domain-name">${domain.replace('www.', '')}</span>
              ${this.getProductivityBadge(domain)}
            </div>
          </td>
          <td>${formatTime(time)}</td>
          <td>
            <div class="progress-bar">
              <div class="progress" style="width: ${(time / totalTime) * 100}%"></div>
              <span>${((time / totalTime) * 100).toFixed(1)}%</span>
            </div>
          </td>
        </tr>
      `).join('');
  }

  getProductivityBadge(domain) {
    if (this.productivityCategories.productive.some(pd => domain.includes(pd))) {
      return '<span class="badge productive">(Productive!)</span>';
    } else if (this.productivityCategories.distracting.some(dd => domain.includes(dd))) {
      return '<span class="badge distracting">(Distracting)</span>';
    }
    return '';
  }

  filterLowTimeEntries(data, threshold) {
    return Object.entries(data)
      .filter(([_, time]) => time >= threshold)
      .reduce((obj, [key, value]) => {
        obj[key] = value;
        return obj;
      }, {});
  }

  showDetailedView() {
    const modal = document.getElementById('detailedModal');
    modal.style.display = 'block';
    this.updateDetailedTable(this.currentData);
  }

  closeModal() {
    const modal = document.getElementById('detailedModal');
    modal.style.display = 'none';
  }

  handleSearch(event) {
    const searchTerm = event.target.value.toLowerCase();
    this.filterDetailedTable(searchTerm, this.currentTimeFilter);
  }

  handleTimeFilter(event) {
    const filterValue = event.target.value;
    let minTime = 0;
    
    switch(filterValue) {
      case '1m':
        minTime = 60000;
        break;
      case '5m':
        minTime = 300000;
        break;
      case '30m':
        minTime = 1800000;
        break;
    }

    this.currentTimeFilter = minTime;
    this.filterDetailedTable(this.currentSearchTerm, minTime);
  }

  updateDetailedTable(data) {
    const totalTime = Object.values(data).reduce((sum, time) => sum + time, 0);
    const tbody = document.querySelector('.detailed-table tbody');
    
    tbody.innerHTML = Object.entries(data)
      .sort((a, b) => b[1] - a[1])
      .map(([domain, time]) => `
        <tr>
          <td>
            <div class="domain-cell">
              <span class="domain-name">${domain.replace('www.', '')}</span>
              ${this.getProductivityBadge(domain)}
            </div>
          </td>
          <td>${formatTime(time)}</td>
          <td>
            <div class="progress-bar">
              <div class="progress" style="width: ${(time / totalTime) * 100}%"></div>
              <span>${((time / totalTime) * 100).toFixed(1)}%</span>
            </div>
          </td>
        </tr>
      `).join('');
  }

  filterDetailedTable(searchTerm = '', minTime = 0) {
    const rows = document.querySelectorAll('.detailed-table tbody tr');
    rows.forEach(row => {
      const domain = row.querySelector('.domain-name').textContent.toLowerCase();
      const timeCell = row.cells[1].textContent;
      const time = parseTimeToMs(timeCell);
      
      const matchesSearch = domain.includes(searchTerm);
      const matchesTime = time >= minTime;
      
      row.style.display = matchesSearch && matchesTime ? '' : 'none';
    });
  }



  exportData() {
    if (!this.currentData) return;

    const data = Object.entries(this.currentData)
      .map(([domain, time]) => ({
        domain: domain.replace('www.', ''),
        time: formatTime(time),
        category: this.getProductivityCategory(domain),
        percentage: ((time / Object.values(this.currentData).reduce((sum, t) => sum + t, 0)) * 100).toFixed(1)
      }));

    const csv = this.convertToCSV(data);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('hidden', '');
    a.setAttribute('href', url);
    a.setAttribute('download', `browsing-stats-${this.currentPeriod}.csv`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  convertToCSV(data) {
    const headers = Object.keys(data[0]);
    const rows = data.map(obj => headers.map(header => obj[header]));
    return [
      headers.join(','),
      ...rows.map(row => row.join(','))
  ].join('\n');
}

getProductivityCategory(domain) {
  if (this.productivityCategories.productive.some(pd => domain.includes(pd))) {
    return 'Productive';
  } else if (this.productivityCategories.distracting.some(dd => domain.includes(dd))) {
    return 'Distracting';
  }
  return 'Neutral';
}

}

document.addEventListener('DOMContentLoaded', () => {
  new BrowsingStats().displayStats('day');
});
class SettingsManager {
  constructor() {
    this.currentSettings = {
      siteLimits: {},
      breakReminders: true,
      breakInterval: 30,
      productivityCategories: {
        productive: [],
        neutral: [],
        distracting: []
      }
    };
    this.domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/;
    this.initializeSettings();
  }

  async initializeSettings() {
    await this.loadSettings();
    this.initializeEventListeners();
    this.updateUI();
  }

  initializeEventListeners() {
    document.getElementById('breakReminders')?.addEventListener('change', e => {
      this.currentSettings.breakReminders = e.target.checked;
    });

    document.getElementById('addProductiveSite')?.addEventListener('click', () => this.addProductivitySite('productive'));
document.getElementById('addNeutralSite')?.addEventListener('click', () => this.addProductivitySite('neutral'));
document.getElementById('addDistractingSite')?.addEventListener('click', () => this.addProductivitySite('distracting'));

    document.getElementById('breakInterval')?.addEventListener('change', e => {
      const value = parseInt(e.target.value);
      if (value >= 5 && value <= 120) {
        this.currentSettings.breakInterval = value;
      }
    });

    document.getElementById('addLimitBtn')?.addEventListener('click', () => this.addLimit());
    document.getElementById('saveBtn')?.addEventListener('click', () => this.saveSettings());
  }

  async loadSettings() {
    const settings = await StorageManager.get('settings');
    if (settings) {
      this.currentSettings = settings;
    }
  }

  addProductivitySite(category) {
    const input = document.getElementById(`${category}Site`);
    const site = input.value.trim();
    
    if (!this.validateDomain(site)) {
      this.showError('Please enter a valid domain (e.g., example.com)');
      return;
    }
    ['productive', 'neutral', 'distracting'].forEach(cat => {
      this.currentSettings.productivityCategories[cat] = 
        this.currentSettings.productivityCategories[cat].filter(s => s !== site);
    });
    
    this.currentSettings.productivityCategories[category].push(site);
    this.displayProductivitySites();
    input.value = '';
    this.hideError();
  }
  
  removeProductivitySite(category, site) {
    this.currentSettings.productivityCategories[category] = 
      this.currentSettings.productivityCategories[category].filter(s => s !== site);
    this.displayProductivitySites();
  }
  
  displayProductivitySites() {
    ['productive', 'neutral', 'distracting'].forEach(category => {
      const list = document.getElementById(`${category}List`);
      if (!list) return;
      
      list.innerHTML = '';
      this.currentSettings.productivityCategories[category].forEach(site => {
        const div = document.createElement('div');
        div.className = 'site-item';
        div.innerHTML = `
          <span class="domain-text">${site}</span>
          <button class="btn remove">Remove</button>
        `;
        
        div.querySelector('.remove').addEventListener('click', () => {
          this.removeProductivitySite(category, site);
        });
        
        list.appendChild(div);
      });
    });
  }

  updateUI() {
    const breakReminders = document.getElementById('breakReminders');
    const breakInterval = document.getElementById('breakInterval');
    
    if (breakReminders) {
      breakReminders.checked = this.currentSettings.breakReminders;
    }
    if (breakInterval) {
      breakInterval.value = this.currentSettings.breakInterval;
    }
    this.displayProductivitySites();
    
    this.displayCurrentLimits();
  }

  displayCurrentLimits() {
    const limitsList = document.getElementById('limitsList');
    if (!limitsList) return;
    
    limitsList.innerHTML = '';
    Object.entries(this.currentSettings.siteLimits).forEach(([site, limit]) => {
      const div = document.createElement('div');
      div.className = 'site-limit';
      div.innerHTML = `
        <span class="domain-text">${site}</span>
        <input type="number" value="${limit}" min="1" max="1440" class="limit-input">
        <button class="btn remove">Remove</button>
      `;
      
      div.querySelector('input').addEventListener('change', e => {
        this.updateLimit(site, parseInt(e.target.value));
      });
      
      div.querySelector('.remove').addEventListener('click', () => {
        this.removeLimit(site);
      });
      
      limitsList.appendChild(div);
    });
  }

  addLimit() {
    const siteInput = document.getElementById('newSite');
    const limitInput = document.getElementById('newLimit');
    
    const site = siteInput.value.trim();
    const limit = parseInt(limitInput.value);
    
    if (!this.validateDomain(site)) {
      this.showError('Please enter a valid domain (e.g., example.com)');
      return;
    }
    
    if (!limit || limit < 1 || limit > 1440) {
      this.showError('Limit must be between 1 and 1440 minutes');
      return;
    }
    
    this.currentSettings.siteLimits[site] = limit;
    this.displayCurrentLimits();
    siteInput.value = '';
    limitInput.value = '';
    this.hideError();
  }

  validateDomain(domain) {
    return this.domainPattern.test(domain);
  }

  removeLimit(site) {
    delete this.currentSettings.siteLimits[site];
    this.displayCurrentLimits();
  }

  updateLimit(site, limit) {
    if (limit > 0 && limit <= 1440) {
      this.currentSettings.siteLimits[site] = limit;
    }
  }

  async saveSettings() {
    try {
      await StorageManager.set('settings', this.currentSettings);
      this.showSaveConfirmation();
    } catch (error) {
      this.showError('Failed to save settings');
    }
  }

  showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    
    const existingError = document.querySelector('.error-message');
    if (existingError) {
      existingError.remove();
    }
    
    document.querySelector('.setting-group').prepend(errorDiv);
  }

  hideError() {
    document.querySelector('.error-message')?.remove();
  }

  showSaveConfirmation() {
    const notification = document.querySelector('.save-notification');
    if (notification) {
      notification.hidden = false;
      setTimeout(() => notification.hidden = true, 2000);
    }
  }
}

if (document.querySelector('.setting-group')) {
  new SettingsManager();
}
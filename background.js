class ActivityTracker {
  constructor() {
    this.startTime = null;
    this.currentUrl = null;
    this.lastActiveTime = null;
    this.lastUserActivity = null;
    this.isSystemActive = true;
    
    this.IDLE_THRESHOLD = 5 * 60 * 1000;
    this.ACTIVITY_CHECK_INTERVAL = 60 * 1000;
    this.MIN_LOG_TIME = 1000;
    
    this.initializeTracker();
  }

  async initializeTracker() {
    chrome.runtime.onInstalled.addListener(() => {
      chrome.alarms.create('activityCheck', { periodInMinutes: 1 });
    });

    this.initializeListeners();
    
    this.checkSystemState();
  }

  initializeListeners() {
    chrome.tabs.onActivated.addListener(this.handleTabChange.bind(this));
    chrome.tabs.onUpdated.addListener(this.handleTabUpdate.bind(this));
    
    chrome.idle.setDetectionInterval(Math.floor(this.IDLE_THRESHOLD / 1000));
    chrome.idle.onStateChanged.addListener(this.handleIdleState.bind(this));
    
    chrome.runtime.onSuspend.addListener(this.handleSystemSuspend.bind(this));
    chrome.runtime.onStartup.addListener(this.handleSystemStartup.bind(this));
    
    chrome.alarms.onAlarm.addListener(this.handleAlarm.bind(this));
  }

  async handleTabChange(activeInfo) {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.url?.startsWith('http')) {
        this.updateTracking(tab.url);
        this.recordUserActivity();
      }
    } catch (error) {
      console.error('Tab change error:', error);
    }
  }

  handleTabUpdate(tabId, changeInfo) {
    if (changeInfo.url?.startsWith('http')) {
      this.updateTracking(changeInfo.url);
      this.recordUserActivity();
    }
  }

  handleIdleState(state) {
    const now = Date.now();
    
    switch(state) {
      case 'active':
        this.isSystemActive = true;
        this.lastUserActivity = now;
        this.resumeTracking();
        break;
      
      case 'idle':
      case 'locked':
        this.isSystemActive = false;
        this.pauseTracking();
        break;
    }
  }

  handleSystemSuspend() {
    this.isSystemActive = false;
    this.pauseTracking();
  }

  handleSystemStartup() {
    this.isSystemActive = true;
    this.lastUserActivity = Date.now();
    this.resumeTracking();
  }

  async handleAlarm(alarm) {
    if (alarm.name === 'activityCheck') {
      await this.checkActivity();
    }
  }

  async checkActivity() {
    const now = Date.now();
    
    if (!this.isSystemActive || !this.lastUserActivity || 
        (now - this.lastUserActivity > this.IDLE_THRESHOLD)) {
      this.pauseTracking();
      return;
    }

    if (this.currentUrl && this.startTime) {
      await this.checkLimitsAndBreaks();
    }
  }

  recordUserActivity() {
    this.lastUserActivity = Date.now();
  }

  async checkSystemState() {
    try {
      const state = await chrome.idle.queryState(Math.floor(this.IDLE_THRESHOLD / 1000));
      this.handleIdleState(state);
    } catch (error) {
      console.error('System state check error:', error);
    }
  }

  async updateTracking(newUrl) {
    const now = Date.now();
    
    if (this.currentUrl && this.startTime) {
      const timeSpent = now - this.startTime;
      if (timeSpent >= this.MIN_LOG_TIME) {
        await this.logBrowsingTime(this.currentUrl, timeSpent);
      }
    }
    this.currentUrl = newUrl;
    this.startTime = newUrl ? now : null;
    this.recordUserActivity();
  }

  pauseTracking() {
    if (this.currentUrl && this.startTime) {
      const timeSpent = Date.now() - this.startTime;
      if (timeSpent >= this.MIN_LOG_TIME) {
        this.logBrowsingTime(this.currentUrl, timeSpent);
      }
    }
    this.currentUrl = null;
    this.startTime = null;
  }

  resumeTracking() {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0]?.url?.startsWith('http')) {
        this.updateTracking(tabs[0].url);
      }
    });
  }

  async logBrowsingTime(url, timeSpent) {
    try {
      const domain = new URL(url).hostname;
      const date = new Date().toISOString().split('T')[0];
      
      const data = await chrome.storage.local.get('browsingHistory');
      const history = data.browsingHistory || {};
      
      if (!history[date]) history[date] = {};
      history[date][domain] = (history[date][domain] || 0) + timeSpent;
      
      await chrome.storage.local.set({ browsingHistory: history });
      
      this.cleanupOldData(history);
    } catch (error) {
      console.error('Logging error:', error);
    }
  }

  async cleanupOldData(history) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    let modified = false;
    Object.keys(history).forEach(date => {
      if (new Date(date) < thirtyDaysAgo) {
        delete history[date];
        modified = true;
      }
    });
    
    if (modified) {
      await chrome.storage.local.set({ browsingHistory: history });
    }
  }

  async checkLimitsAndBreaks() {
    if (!this.currentUrl || !this.startTime) return;
    
    const now = Date.now();
    const domain = new URL(this.currentUrl).hostname;
    const settings = await chrome.storage.local.get('settings');
    
    if (settings?.settings) {
      await this.checkSiteLimits(domain, settings.settings);
      await this.checkBreakReminders(now, settings.settings);
    }
  }

  async checkSiteLimits(domain, settings) {
    const limit = settings.siteLimits?.[domain];
    if (!limit) return;
    
    const today = new Date().toISOString().split('T')[0];
    const history = await chrome.storage.local.get('browsingHistory');
    const timeSpent = history?.browsingHistory?.[today]?.[domain] || 0;
    
    if (timeSpent > limit * 60000) {
      this.showLimitNotification(domain);
    }
  }

  async checkBreakReminders(now, settings) {
    if (!settings.breakReminders || !this.startTime) return;
    
    const timeSpent = now - this.startTime;
    if (timeSpent > settings.breakInterval * 60000) {
      this.showBreakNotification(settings.breakInterval);
      this.startTime = now;
    }
  }

  showLimitNotification(domain) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'images/icon128.png',
      title: 'Time Limit Reached',
      message: `You've reached your daily limit for ${domain}`,
      buttons: [{ title: 'Dismiss' }, { title: 'View Stats' }]
    });
  }

  showBreakNotification(interval) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'images/icon128.png',
      title: 'Time for a Break',
      message: `You've been browsing for ${interval} minutes. Time to stretch!`,
      requireInteraction: true
    });
  }
}

new ActivityTracker();
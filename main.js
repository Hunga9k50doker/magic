const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson, updateEnv, decodeJWT } = require("./utils");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./checkAPI");
const headers = require("./core/header");
const { DateTime } = require("luxon");

class ClientAPI {
  constructor(queryId, accountIndex, proxy, baseURL) {
    this.headers = headers;
    this.baseURL = baseURL;
    this.queryId = queryId;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = queryId;
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.accountIndex;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent, try get new query_id: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Tài khoản ${this.accountIndex + 1}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 1,
      isAuth: false,
    }
  ) {
    const { retries, isAuth } = options;

    const headers = {
      ...this.headers,
    };

    if (!isAuth) {
      headers["Cookie"] = `__Secure-next-auth.session-token=${this.token}`;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0,
      success = false;
    do {
      try {
        const response = await axios({
          method,
          url: `${url}`,
          data,
          headers,
          httpsAgent: proxyAgent,
          timeout: 30000,
        });
        success = true;
        if (response?.data?.data) return { success: true, data: response.data.data };
        return { success: true, data: response.data };
      } catch (error) {
        if (error.status == 400) {
          // this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: error.response.data.error || error.response.data.message || error.message };
        }
        this.log(`Yêu cầu thất bại: ${url} | ${error.message} | đang thử lại...`, "warning");
        success = false;
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        if (currRetries == retries) return { success: false, error: error.message };
      }
      currRetries++;
    } while (currRetries <= retries && !success);
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/user`, "get");
  }

  async getQuests() {
    return this.makeRequest(`${this.baseURL}/quests`, "get");
  }

  async getUserQuests() {
    return this.makeRequest(`${this.baseURL}/userQuests`, "get");
  }

  async action(payload) {
    return this.makeRequest(`${this.baseURL}/userQuests`, "post", payload);
  }

  async getDailyDiceRollId() {
    try {
      const questsResult = await this.getQuests();
      if (!questsResult.success) {
        this.log("Failed to fetch quests", "warning");
        return null;
      }

      const diceRollQuest = questsResult.data.find((quest) => quest.title === "Daily Dice Roll");
      if (!diceRollQuest) {
        this.log("Daily Dice Roll quest not found", "warning");
        return null;
      }

      return diceRollQuest.id;
    } catch (error) {
      this.log(`Error getting Daily Dice Roll ID: ${error.message}`, "error");
      return null;
    }
  }

  async checkDiceRollAvailability() {
    try {
      const diceRollId = await this.getDailyDiceRollId();
      if (!diceRollId) {
        return false;
      }

      const userQuestsResult = await this.getUserQuests();
      if (!userQuestsResult.success) {
        this.log("Failed to fetch user quests", "warning");
        return false;
      }

      const diceRollQuest = userQuestsResult.data.find((quest) => quest.questId === diceRollId);

      if (!diceRollQuest) {
        return true;
      }

      const lastUpdateTime = DateTime.fromISO(diceRollQuest.updatedAt);
      const currentTime = DateTime.now();
      const hoursDiff = currentTime.diff(lastUpdateTime, "hours").hours;

      if (hoursDiff < 24) {
        const remainingHours = Math.ceil(24 - hoursDiff);
        this.log(`Not yet Roll Dice time, time remaining ${remainingHours} hour`, "warning");
        return false;
      }

      return true;
    } catch (error) {
      this.log(`Error checking dice roll availability: ${error.message}`, "warning");
      return false;
    }
  }

  async performDiceRoll(diceRollId) {
    const payload = {
      questId: diceRollId,
      metadata: {
        action: "ROLL",
      },
    };

    try {
      const userQuestsResult = await this.getUserQuests();
      if (userQuestsResult.success) {
        const completedQuests = userQuestsResult.data.filter((quest) => quest.questId === diceRollId && quest.status === "COMPLETED");

        if (completedQuests.length > 0) {
          const mostRecentQuest = completedQuests.sort((a, b) => DateTime.fromISO(b.updatedAt).toMillis() - DateTime.fromISO(a.updatedAt).toMillis())[0];

          const lastUpdateTime = DateTime.fromISO(mostRecentQuest.updatedAt).setZone("local");
          const currentTime = DateTime.now().setZone("local");
          const hoursDiff = currentTime.diff(lastUpdateTime, "hours").hours;

          if (hoursDiff >= 24) {
            this.log(`Over 24 hours since last roll, proceed to new roll...`, "info");
          } else {
            const nextRollTime = lastUpdateTime.plus({ hours: 24 });
            this.log(`Quest completed before, credits received: ${mostRecentQuest.credits}`, "warning");
            if (mostRecentQuest._diceRolls) {
              this.log(`Previous rolls: [${mostRecentQuest._diceRolls.join(", ")}]`, "custom");
            }
            this.log(`Next roll time: ${nextRollTime.toFormat("dd/MM/yyyy HH:mm:ss")}`, "info");
            return true;
          }
        }
      }
      let isCompleted = false;
      let totalCredits = 0;
      let allRolls = [];

      while (!isCompleted) {
        const response = await this.action(payload);

        if (response.success) {
          const { status, credits, _diceRolls, updatedAt } = response.data;

          if (_diceRolls) {
            allRolls = allRolls.concat(_diceRolls);
            this.log(`Rolls: [${_diceRolls.join(", ")}]`, "custom");
          }

          if (credits) {
            totalCredits += credits;
          }

          if (status === "COMPLETED") {
            isCompleted = true;
            const serverTime = DateTime.fromISO(updatedAt);
            const localNextRollTime = serverTime.plus({ hours: 24 }).setZone("local");

            this.log(`Roll dice completed | Reward: ${totalCredits} credits | Next roll time: ${localNextRollTime.toFormat("dd/MM/yyyy HH:mm:ss")}`, "success");
          } else if (status === "PENDING") {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } else {
          if (response?.status == 400 && response?.error == "Quest already completed") {
            const userQuestsResult = await this.getUserQuests();
            if (userQuestsResult.success) {
              const completedQuests = userQuestsResult.data.filter((quest) => quest.questId === diceRollId && quest.status === "COMPLETED");

              if (completedQuests.length > 0) {
                const mostRecentQuest = completedQuests.sort((a, b) => DateTime.fromISO(b.updatedAt).toMillis() - DateTime.fromISO(a.updatedAt).toMillis())[0];

                const lastUpdateTime = DateTime.fromISO(mostRecentQuest.updatedAt).setZone("local");
                const currentTime = DateTime.now().setZone("local");
                const hoursDiff = currentTime.diff(lastUpdateTime, "hours").hours;

                if (hoursDiff >= 24) {
                  this.log(`Over 24 hour since last roll, try roll again...`, "info");
                  return await this.performDiceRoll(diceRollId);
                } else {
                  const nextRollTime = lastUpdateTime.plus({ hours: 24 });
                  this.log(`Quest completed before, credits received: ${mostRecentQuest.credits}`, "warning");
                  if (mostRecentQuest._diceRolls) {
                    this.log(`Previous rolls: [${mostRecentQuest._diceRolls.join(", ")}]`, "custom");
                  }
                  this.log(`Next roll time: ${nextRollTime.toFormat("dd/MM/yyyy HH:mm:ss")}`, "info");
                  return true;
                }
              }
            }
          }

          return false;
        }
      }

      return true;
    } catch (error) {
      this.log(`Error performing dice roll: ${error.message}`, "warning");
      return false;
    }
  }

  async checkAndPerformDiceRoll(diceRollId) {
    try {
      const userQuestsResult = await this.getUserQuests();
      if (!userQuestsResult.success) {
        return false;
      }

      const diceRollQuest = userQuestsResult.data.find((quest) => quest.questId === diceRollId);

      let shouldRoll = false;

      if (!diceRollQuest) {
        shouldRoll = true;
      } else {
        const lastUpdateTime = DateTime.fromISO(diceRollQuest.updatedAt).setZone("local");
        const currentTime = DateTime.now().setZone("local");
        const hoursDiff = currentTime.diff(lastUpdateTime, "hours").hours;

        if (hoursDiff >= 24) {
          shouldRoll = true;
        } else {
          const remainingHours = Math.ceil(24 - hoursDiff);
          const nextRollTime = lastUpdateTime.plus({ hours: 24 });
          this.log(`Not yet Roll Dice time, time remaining ${remainingHours} | ${nextRollTime.toFormat("dd/MM/yyyy HH:mm:ss")}`, "warning");
        }
      }

      if (shouldRoll) {
        return await this.performDiceRoll(diceRollId);
      }

      return false;
    } catch (error) {
      this.log(`Error checking and performing dice roll: ${error.message}`, "error");
      return false;
    }
  }

  async checkAndPerformSocialQuests() {
    try {
      const questsResult = await this.getQuests();
      if (!questsResult.success) {
        this.log("Failed to fetch quests", "warning");
        return;
      }

      const userQuestsResult = await this.getUserQuests();
      if (!userQuestsResult.success) {
        this.log("Failed to fetch user quests", "warning");
        return;
      }

      const completedQuestIds = new Set(userQuestsResult.data.map((quest) => quest.questId));

      const socialQuests = questsResult.data.filter((quest) => quest.title.startsWith("Follow ") && quest.title !== "Follow Discord Server");

      for (const quest of socialQuests) {
        if (!completedQuestIds.has(quest.id)) {
          await this.performSocialQuest(quest.id, quest.title);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch (error) {
      this.log(`Error processing social quests: ${error.message}`, "error");
    }
  }

  async performSocialQuest(questId, platform) {
    const payload = {
      questId: questId,
      metadata: {},
    };

    try {
      const response = await this.action(payload);
      if (response.success) {
        const { credits } = response.data;
        this.log(`Do the task ${platform} success, receive ${credits} Credits`, "success");
        return true;
      } else {
        if (response?.status === 400) {
          this.log(`Mission ${platform} previously completed`, "warning");
          return true;
        }
      }
      return false;
    } catch (error) {
      this.log(`Error performing ${platform} quest: ${error.message}`, "error");
      return false;
    }
  }

  async getNextRollTime(diceRollId) {
    try {
      const userQuestsResult = await this.getUserQuests();
      if (!userQuestsResult.success) {
        return null;
      }

      const completedQuests = userQuestsResult.data.filter((quest) => quest.questId === diceRollId && quest.status === "COMPLETED");

      if (completedQuests.length === 0) {
        return DateTime.now();
      }

      const latestQuest = completedQuests.reduce((latest, current) => {
        const currentTime = DateTime.fromISO(current.updatedAt);
        const latestTime = DateTime.fromISO(latest.updatedAt);
        return currentTime > latestTime ? current : latest;
      });

      const lastUpdateTime = DateTime.fromISO(latestQuest.updatedAt).setZone("local");
      return lastUpdateTime.plus({ hours: 24 });
    } catch (error) {
      this.log(`Error getting next roll time: ${error.message}`, "error");
      return null;
    }
  }

  calculateWaitTime(accountResults) {
    const validResults = accountResults.filter((result) => result.success && result.nextRollTime !== null);

    if (validResults.length === 0) {
      return 24 * 60 * 60;
    }

    const now = DateTime.now();

    const latestResult = validResults.reduce((latest, current) => {
      return current.nextRollTime > latest.nextRollTime ? current : latest;
    });

    let waitSeconds = Math.ceil(latestResult.nextRollTime.diff(now, "seconds").seconds);

    waitSeconds += 5 * 60;

    if (waitSeconds < 300) {
      return 24 * 60 * 60;
    }

    this.log(`Account with the longest wait time: ${latestResult.email}`, "info");
    return waitSeconds;
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = accountIndex;
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    let userData = { success: false, data: null },
      retries = 0;
    do {
      userData = await this.getUserData();
      if (userData?.success) break;
      retries++;
    } while (retries < 2);

    if (userData.success) {
      const { email, refCode } = userData.data;
      // console.log(userData.data);
      this.log(`Account ${email.yellow} | refcode: ${refCode.green}`, "custom");

      await this.checkAndPerformSocialQuests();

      const diceRollId = await this.getDailyDiceRollId();
      if (diceRollId) {
        const rollPerformed = await this.checkAndPerformDiceRoll(diceRollId);
        const nextRollTime = await this.getNextRollTime(diceRollId);
        return {
          success: true,
          nextRollTime: nextRollTime,
          email: email,
        };
      }
    } else {
      return this.log("Can't get use info...skipping", "error");
    }
  }
}

async function runWorker(workerData) {
  const { queryId, accountIndex, proxy, hasIDAPI } = workerData;
  const to = new ClientAPI(queryId, accountIndex, proxy, hasIDAPI);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  const queryIds = loadData("data.txt");
  const proxies = loadData("proxy.txt");
  if (queryIds.length > proxies.length && settings.USE_PROXY) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${queryIds.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  console.log("Tool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)".yellow);
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const { endpoint: hasIDAPI, message } = await checkBaseUrl();
  if (!hasIDAPI) return console.log(`Không thể tìm thấy ID API, thử lại sau!`.red);
  console.log(`${message}`.yellow);
  // process.exit();
  queryIds.map((val, i) => new ClientAPI(val, i, proxies[i], hasIDAPI).createUserAgent());

  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];

    while (currentIndex < queryIds.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, queryIds.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI,
            queryId: queryIds[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < queryIds.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    await sleep(3);
    console.log("Tool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)".yellow);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}

function getProfileNames() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const pidIndex = headerRow.indexOf("PID");
  if (pidIndex !== -1) {
    console.log("PID column found at index: " + (pidIndex + 1));
    //handlePIDColumn(pidIndex + 1); // Column numbers are 1-based in Sheets
    let columnNumber = pidIndex + 1;
    console.log("Handling PID column at position: " + columnNumber);
    const brand = checkForBrand();
    updateProfileNamesAndAvatarsFlexible(columnNumber, brand);
  } else {
    console.log("PID column not found.");
  }
}

function checkForBrand() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const index = headerRow.indexOf("subbrand_desc");

  // 1. Check subbrand_desc column
  if (index !== -1) {
    console.log("Brand column found at index: " + (index + 1));
    const values = sheet.getRange(2, index + 1, Math.max(1, sheet.getLastRow() - 1)).getValues().flat();
    const firstNonEmpty = values.find(v => v && v.toString().trim() !== "");
    if (firstNonEmpty) {
      console.log("Brand value detected in column: " + firstNonEmpty);
      return firstNonEmpty.toString().trim();
    }
    console.log("Brand column exists but is empty.");
  } else {
    console.log("Brand column not found.");
  }

  // 2. Fallback: check sheet name
  const sheetName = sheet.getName().toLowerCase();
  console.log("Sheet name: " + sheetName);

  if (sheetName.includes("mozambique") || sheetName.includes("moz")) {
    console.log("Brand set from sheet name: 888bets Mozambique");
    return "888bets Mozambique";
  }
  if (sheetName.includes("angola") || sheetName.includes("ang")) {
    console.log("Brand set from sheet name: 888bets Angola");
    return "888bets Angola";
  }
  if (sheetName.includes("zambia") || sheetName.includes("zam")) {
    console.log("Brand set from sheet name: BetLion Zambia");
    return "BetLion Zambia";
  }

  // 3. Nothing matched
  console.log("No brand detected. Returning empty string.");
  return "";
}



function updateProfileNamesAndAvatarsFlexible(columnNumber, brand) {
  console.log("Column Number passed in: " + columnNumber);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const pidRange = sheet.getRange(2, columnNumber, lastRow - 1);
  const pids = pidRange.getValues().flat().filter(pid => pid); // Flatten and remove empty
  const pidsAsStrings = pids.map(pid => pid.toString());

  console.log("PIDs: " + JSON.stringify(pidsAsStrings));

  if (pids.length === 0) {
    SpreadsheetApp.getUi().alert("No PIDs found in the specified column.");
    return;
  }

  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  let DEFAULT_AVATAR;
  if (brand == "BetLion Zambia") {
    DEFAULT_AVATAR = "https://gamepage.betlion.co.zm/wp-content/themes/megamission/images/avatars/avatardefault.webp";  

  } else if (brand == "888bets Mozambique") {
    DEFAULT_AVATAR = "https://blaze.888bets.co.mz/wp-content/uploads/2025/02/Property-1Mystery.png";

  } else if (brand == "888bets Angola") {
    DEFAULT_AVATAR = "https://blaze.888bets.co.mz/wp-content/uploads/2025/02/Property-1Mystery.png";

  } else {
    DEFAULT_AVATAR = "";
  }

  // Prepare POST payload
  const payload = JSON.stringify({ pids: pidsAsStrings });

  let response;
  if (brand == "BetLion Zambia") {
    response = UrlFetchApp.fetch("https://gamepage.betlion.co.zm/wp-json/betlion-zambia/profile-names-by-pids", {
      method: "post",
      contentType: "application/json",
      payload: payload,
      muteHttpExceptions: true
    });
  } else if (brand == "888bets Mozambique") {
    response = UrlFetchApp.fetch("https://888africa.com/888bets-mozambique/wp-json/profiles/v1/profile-names-by-pids", {
      method: "post",
      contentType: "application/json",
      payload: payload,
      muteHttpExceptions: true
    });
  } else if (brand == "888bets Angola") {
    response = UrlFetchApp.fetch("https://888africa.com/888bets-mozambique/wp-json/profiles/v1/profile-names-by-pids", { //<!--this needs changing to the angola DB
      method: "post",
      contentType: "application/json",
      payload: payload,
      muteHttpExceptions: true
    });
  } else {
    response = null;
  }

  if (!response || response.getResponseCode() !== 200) {
    SpreadsheetApp.getUi().alert("Failed to fetch profiles: " + (response ? response.getContentText() : "No response"));
    return;
  }

  const results = JSON.parse(response.getContentText());

  const lookup = results.reduce((map, r) => {
    map[r.pid] = { 
      name: r.profile_name, 
      avatar: r.avatar, 
      phone: r.phone_number || "" 
    };
    return map;
  }, {});

let totalColumns = sheet.getLastColumn();
  // Locate or create columns (corrected existence checks)
let nameCol = headerRow.indexOf("Profile Name");
let avatarCol = headerRow.indexOf("Avatar");
let avatarImgCol = headerRow.indexOf("Avatar Image");
let phoneCol = headerRow.indexOf("Telephone");

// Convert to 1-based column index only after checking for existence
if (nameCol === -1) {
  nameCol = totalColumns + 1;
  sheet.getRange(1, nameCol).setValue("Profile Name");
  totalColumns++;
} else {
  nameCol = nameCol + 1;
}

if (avatarCol === -1) {
  avatarCol = totalColumns + 1;
  sheet.getRange(1, avatarCol).setValue("Avatar");
  totalColumns++;
} else {
  avatarCol = avatarCol + 1;
}

if (avatarImgCol === -1) {
  avatarImgCol = totalColumns + 1;
  sheet.getRange(1, avatarImgCol).setValue("Avatar Image");
  totalColumns++;
} else {
  avatarImgCol = avatarImgCol + 1;
}

if (phoneCol === -1) {
  phoneCol = totalColumns + 1;
  sheet.getRange(1, phoneCol).setValue("Telephone");
  totalColumns++;
} else {
  phoneCol = phoneCol + 1;
}

  const namesToWrite = [];
  const avatarsToWrite = [];
  const avatarFormulas = [];
  const phonesToWrite = [];

  let realNameCount = 0;

  for (let i = 0; i < pids.length; i++) {
    const pid = pids[i];
    const entry = lookup[pid] || {};

    // Assign profile name (ID: PID when no real name)
    const profileName =
      entry.name && entry.name.toString().trim() !== pid.toString().trim()
        ? entry.name
        : `ID: ${pid}`;

    const avatarUrl = entry.avatar || DEFAULT_AVATAR;
    const phone = entry.phone || "";

    // Count real names correctly
    const isRealName =
      entry.name &&
      entry.name.toString().trim() !== pid.toString().trim();

    if (isRealName) realNameCount++;

    namesToWrite.push([profileName]);
    avatarsToWrite.push([avatarUrl]);
    avatarFormulas.push([`=IMAGE("${avatarUrl}")`]);
    phonesToWrite.push([phone]);
  }



  // Clear old contents first
  sheet.getRange(2, nameCol, lastRow - 1).clearContent();
  sheet.getRange(2, avatarCol, lastRow - 1).clearContent();
  sheet.getRange(2, avatarImgCol, lastRow - 1).clearContent();
  sheet.getRange(2, phoneCol, lastRow - 1).clearContent();

  // Write new values
  sheet.getRange(2, nameCol, namesToWrite.length, 1).setValues(namesToWrite);
  sheet.getRange(2, avatarCol, avatarsToWrite.length, 1).setValues(avatarsToWrite);
  sheet.getRange(2, avatarImgCol, avatarFormulas.length, 1).setFormulas(avatarFormulas);
  sheet.getRange(2, phoneCol, phonesToWrite.length, 1).setValues(phonesToWrite);

  const summary = `✅ Done! \n \n Profile names, avatars, images, and telephone numbers refreshed.\n👤 Real names retrieved: ${realNameCount} of ${pids.length}`;
  SpreadsheetApp.getUi().alert(summary);
}


// ---------------- SEND PROFILE NAMES TO DB


function setProfileNames(){
   if (pidIndex !== -1) {
    console.log("PID column found at index: " + (pidIndex + 1));
    //handlePIDColumn(pidIndex + 1); // Column numbers are 1-based in Sheets
    columnNumber = pidIndex + 1;
    console.log("Handling PID column at position: " + columnNumber);
    const brand = checkForBrand();
    updateProfileNamesAndAvatarsFlexible(columnNumber, brand);
  } else {
    console.log("PID column not found.");
  }
  
}


function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu("🔥 Profile Tools v2.")
    .addItem("GET Profiles", "getProfileNames")
    .addItem("SET Profiles", "setProfileNames")
    .addToUi();
}
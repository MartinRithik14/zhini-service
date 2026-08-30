// services/wekan.service.js

export const getWekanAuthHeaders = async () => {
  const baseUrl = process.env.WEKAN_BASE_URL || "http://localhost:8080";
  const username = process.env.WEKAN_ADMIN_USERNAME;
  const password = process.env.WEKAN_ADMIN_PASSWORD;

  if (!username || !password) {
    throw new Error("WEKAN_ADMIN_USERNAME or WEKAN_ADMIN_PASSWORD is missing from environment variables.");
  }

  const response = await fetch(`${baseUrl}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: username,
      password: password,
    }),
  });

  if (!response.ok) {
    throw new Error(`Wekan login failed with status ${response.status}`);
  }

  const data = await response.json();

  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${data.token}`,
    "X-User-Id": data.id,
  };
};

export const createProviderBoard = async (mobileNumber) => {
  const baseUrl = process.env.WEKAN_BASE_URL || "http://localhost:8080";
  const headers = await getWekanAuthHeaders();
  
  const currentYear = new Date().getFullYear();
  const boardTitle = `${mobileNumber}_${currentYear}`;

  // 1. Create the Board
  const boardRes = await fetch(`${baseUrl}/api/boards`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: boardTitle,
      owner: headers["X-User-Id"],
      isAdmin: true,
      permission: "private",
    }),
  });

  if (!boardRes.ok) {
    const errText = await boardRes.text();
    throw new Error(`Board creation failed (${boardRes.status}): ${errText}`);
  }

  const boardData = await boardRes.json();
  const boardId = boardData._id || boardData.id;

  const requiredLists = [
    "New",
    "Accepted",
    "Rejected",
    "Canceled",
    "In Progress",
    "Waiting for Parts",
    "Completed",
  ];
  const listMap = {};

  // 2. Create lists
  for (const listTitle of requiredLists) {
    const listRes = await fetch(`${baseUrl}/api/boards/${boardId}/lists`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: listTitle }),
    });

    if (listRes.ok) {
      const listData = await listRes.json();
      listMap[listTitle] = listData._id || listData.id;
    }
  }

  console.log(`✅ Created Wekan board "${boardTitle}" (ID: ${boardId})`);

  return {
    boardId,
    lists: listMap,
  };
};

export const createServiceCard = async (boardId, listId, { title, description, customerPhone }) => {
  const baseUrl = process.env.WEKAN_BASE_URL || "http://localhost:8080";
  const headers = await getWekanAuthHeaders();
  const userId = headers["X-User-Id"];

  const swimlaneTitle = customerPhone || "General Customer";

  // 1. Fetch existing swimlanes for this board
  const swimlanesRes = await fetch(`${baseUrl}/api/boards/${boardId}/swimlanes`, { headers });
  if (!swimlanesRes.ok) {
    const errText = await swimlanesRes.text();
    throw new Error(`Failed to fetch swimlanes (${swimlanesRes.status}): ${errText}`);
  }

  const swimlanes = await swimlanesRes.json();
  let targetSwimlane = swimlanes.find((s) => s.title === swimlaneTitle);

  // 2. Handle Swimlane Binding
  if (!targetSwimlane) {
    // Check if board only has Wekan's automatically created Default swimlane
    const defaultSwimlane = swimlanes.find((s) => s.title === "Default" || s.type === "default");

    if (defaultSwimlane) {
      // OVERWRITE the Default swimlane with Customer Number to inherit all built-in list grid cells
      const renameRes = await fetch(`${baseUrl}/api/boards/${boardId}/swimlanes/${defaultSwimlane._id || defaultSwimlane.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ title: swimlaneTitle }),
      });

      if (renameRes.ok) {
        targetSwimlane = await renameRes.json();
      } else {
        targetSwimlane = defaultSwimlane;
      }
    } else {
      // Create additional customer swimlane row
      const createSwimlaneRes = await fetch(`${baseUrl}/api/boards/${boardId}/swimlanes`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: swimlaneTitle,
          type: "swimlane",
        }),
      });

      if (!createSwimlaneRes.ok) {
        const errText = await createSwimlaneRes.text();
        throw new Error(`Failed to create swimlane (${createSwimlaneRes.status}): ${errText}`);
      }

      targetSwimlane = await createSwimlaneRes.json();
    }
  }

  const targetSwimlaneId = String(targetSwimlane._id || targetSwimlane.id);

  // 3. Create Card explicitly tied to target swimlane
  const payload = {
    title,
    description,
    authorId: userId,
    userId: userId,
    swimlaneId: targetSwimlaneId,
  };

  const res = await fetch(`${baseUrl}/api/boards/${boardId}/lists/${listId}/cards`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`❌ Wekan Card POST Error Details:`, errText);
    throw new Error(`Failed to create Wekan card (${res.status}): ${errText}`);
  }

  const card = await res.json();
  const createdCardId = card._id || card.id;

  console.log(`✅ Created Card "${title}" (ID: ${createdCardId}) in Swimlane "${swimlaneTitle}"`);
  return createdCardId;
};

// Fixed moveCardToList that retains swimlane reference on move
export const moveCardToList = async (boardId, currentListId, cardId, newListId, swimlaneId) => {
  const baseUrl = process.env.WEKAN_BASE_URL || "http://localhost:8080";
  const headers = await getWekanAuthHeaders();

  const payload = {
    listId: newListId,
  };

  if (swimlaneId) {
    payload.swimlaneId = swimlaneId;
  }

  const res = await fetch(
    `${baseUrl}/api/boards/${boardId}/lists/${currentListId}/cards/${cardId}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to move Wekan card (${res.status}): ${errText}`);
  }

  console.log(`✅ Moved Card ${cardId} to List ${newListId}`);
  return true;
};
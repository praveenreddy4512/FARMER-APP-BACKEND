const fetchButton = document.querySelector('#fetch-button');
const buttonLabel = document.querySelector('#button-label');
const message = document.querySelector('#message');
const commodityList = document.querySelector('#commodity-list');
const commodityCount = document.querySelector('#commodity-count');
const lastUpdated = document.querySelector('#last-updated');
const searchInput = document.querySelector('#search-input');

let commodities = [];

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

function renderCommodities() {
  const term = searchInput.value.trim().toLowerCase();
  const visible = commodities.filter((item) => item.commodity.toLowerCase().includes(term));

  commodityList.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = term ? 'No commodities match that filter.' : 'No commodities returned.';
    commodityList.append(empty);
    return;
  }

  visible.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'commodity-item';
    card.style.animationDelay = `${Math.min(index, 12) * 24}ms`;

    const name = document.createElement('span');
    name.className = 'commodity-name';
    name.title = item.commodity;
    name.textContent = item.commodity;

    const meta = document.createElement('span');
    meta.className = 'commodity-meta';
    meta.textContent = item.latest_date
      ? `Latest ${item.latest_date}`
      : `${item.market_count || 0} markets`;

    card.append(name, meta);
    commodityList.append(card);
  });
}

async function fetchCommodities() {
  fetchButton.disabled = true;
  buttonLabel.textContent = 'Fetching...';
  setMessage('Fetching new prices and replacing the saved mandi data...');

  try {
    const refreshResponse = await fetch('/fetch-now', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const refreshPayload = await refreshResponse.json();
    if (!refreshResponse.ok) {
      throw new Error(refreshPayload.error || 'The price refresh failed.');
    }

    const response = await fetch('/commodities', { headers: { Accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'The saved commodity list could not be loaded.');

    commodities = Array.isArray(payload.commodities) ? payload.commodities : [];
    commodityCount.textContent = commodities.length.toLocaleString();
    lastUpdated.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const refreshMessage = refreshPayload.refreshed === false
      ? 'No new upstream prices were available; existing data was kept.'
      : `${commodities.length.toLocaleString()} commodities loaded with fresh mandi prices.`;
    setMessage(refreshMessage);
    renderCommodities();
  } catch (error) {
    setMessage(error.message || 'Unable to fetch commodities.', true);
  } finally {
    fetchButton.disabled = false;
    buttonLabel.textContent = 'Fetch commodities';
  }
}

fetchButton.addEventListener('click', fetchCommodities);
searchInput.addEventListener('input', renderCommodities);

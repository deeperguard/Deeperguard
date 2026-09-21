(function () {
  const form = document.getElementById('contact-form');
  if (!form) return;
  const status = document.getElementById('contact-status');
  const submit = document.getElementById('contact-submit');

  function setStatus(message, isError) {
    if (!status) return;
    status.textContent = message || '';
    status.hidden = !message;
    status.classList.toggle('is-error', !!isError);
    status.classList.toggle('is-success', !!message && !isError);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('');
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') || '').trim(),
      email: String(data.get('email') || '').trim(),
      subject: String(data.get('subject') || '').trim(),
      message: String(data.get('message') || '').trim(),
      website: String(data.get('website') || '').trim(),
    };
    if (!payload.email) {
      setStatus('Please enter your email address.', true);
      return;
    }
    if (payload.message.length < 10) {
      setStatus('Please write at least 10 characters.', true);
      return;
    }
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Sending…';
    }
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(body.error || 'Could not send your message. Please try again.', true);
        return;
      }
      form.reset();
      setStatus('Thanks — your message was sent. We will reply by email.', false);
    } catch (err) {
      setStatus('Network error. Check your connection and try again.', true);
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Send message';
      }
    }
  });
})();
